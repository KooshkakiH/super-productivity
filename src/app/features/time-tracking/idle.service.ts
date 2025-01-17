import {Injectable} from '@angular/core';
import {IS_ELECTRON} from '../../app.constants';
import {ChromeExtensionInterfaceService} from '../../core/chrome-extension-interface/chrome-extension-interface.service';
import {ProjectService} from '../project/project.service';
import {ElectronService} from 'ngx-electron';
import {TaskService} from '../tasks/task.service';
import {IPC_IDLE_TIME} from '../../../../electron/ipc-events.const';
import { MatDialog } from '@angular/material/dialog';
import {BehaviorSubject, Observable, Subject} from 'rxjs';
import {DialogIdleComponent} from './dialog-idle/dialog-idle.component';
import {ConfigService} from '../config/config.service';
import {Task} from '../tasks/task.model';
import {getWorklogStr} from '../../util/get-work-log-str';
import {distinctUntilChanged, shareReplay} from 'rxjs/operators';

const DEFAULT_MIN_IDLE_TIME = 60000;
const IDLE_POLL_INTERVAL = 1000;

@Injectable({
  providedIn: 'root',
})
export class IdleService {
  public isIdle = false;
  private _isIdle$: BehaviorSubject<boolean> = new BehaviorSubject(false);
  public isIdle$: Observable<boolean> = this._isIdle$.asObservable().pipe(distinctUntilChanged(), shareReplay());

  private _idleTime$: BehaviorSubject<number> = new BehaviorSubject(0);
  public idleTime$: Observable<number> = this._idleTime$.asObservable();
  private _triggerResetBreakTimer$ = new Subject<boolean>();
  public triggerResetBreakTimer$: Observable<boolean> = this._triggerResetBreakTimer$.asObservable();


  private lastCurrentTaskId: string;
  private isIdleDialogOpen = false;
  private idlePollInterval: number;

  constructor(
    private _chromeExtensionInterface: ChromeExtensionInterfaceService,
    private _projectService: ProjectService,
    private _electronService: ElectronService,
    private _taskService: TaskService,
    private _configService: ConfigService,
    private _matDialog: MatDialog,
  ) {
  }

  init() {
    if (IS_ELECTRON) {
      this._electronService.ipcRenderer.on(IPC_IDLE_TIME, (ev, idleTimeInMs) => {
        this.handleIdle(idleTimeInMs);
      });
    }
    this._chromeExtensionInterface.onReady$.subscribe(() => {
      this._chromeExtensionInterface.addEventListener(IPC_IDLE_TIME, (ev, idleTimeInMs) => {
        this.handleIdle(idleTimeInMs);
      });
    });

    // window.setTimeout(() => {
    //   console.log('I am here!');
    //
    //   this.handleIdle(800000);
    // }, 700);
  }

  handleIdle(idleTime) {
    console.log('IDLE_TIME', idleTime, new Date());
    const cfg = this._configService.cfg.misc;
    const minIdleTime = cfg.minIdleTime || DEFAULT_MIN_IDLE_TIME;

    // don't run if option is not enabled
    if (!cfg.isEnableIdleTimeTracking || (cfg.isOnlyOpenIdleWhenCurrentTask && !this._taskService.currentTaskId)) {
      this.isIdle = false;
      this._isIdle$.next(false);
      return;
    }
    if (idleTime > minIdleTime) {
      this.isIdle = true;
      this._isIdle$.next(true);

      if (!this.isIdleDialogOpen) {
        if (this._taskService.currentTaskId) {
          // remove idle time already tracked
          this._taskService.removeTimeSpent(this._taskService.currentTaskId, idleTime);
          this.lastCurrentTaskId = this._taskService.currentTaskId;
          this._taskService.setCurrentId(null);
        } else {
          this.lastCurrentTaskId = null;
        }

        this.isIdleDialogOpen = true;
        this.initIdlePoll(idleTime);
        this._matDialog.open(DialogIdleComponent, {
          restoreFocus: true,
          data: {
            lastCurrentTaskId: this.lastCurrentTaskId,
            idleTime$: this.idleTime$,
          }
        }).afterClosed()
          .subscribe((res: { task: Task | string, isResetBreakTimer: boolean, isTrackAsBreak: boolean }) => {
            const {task, isResetBreakTimer, isTrackAsBreak} = res;
            const timeSpent = this._idleTime$.getValue();

            if (isResetBreakTimer || isTrackAsBreak) {
              this._triggerResetBreakTimer$.next(true);
            }

            if (isTrackAsBreak) {
              // TODO
              this._projectService.addToBreakTime(undefined, undefined, timeSpent);
            }

            if (task) {
              if (typeof task === 'string') {
                this._taskService.add(task, false, {
                  timeSpent: timeSpent,
                  timeSpentOnDay: {
                    [getWorklogStr()]: timeSpent
                  }
                });
              } else {
                this._taskService.addTimeSpent(task.id, timeSpent);
                this._taskService.setCurrentId(task.id);
              }
            }

            this.cancelIdlePoll();
            this._isIdle$.next(false);
            this.isIdleDialogOpen = false;
          });
      }
    }
  }


  initIdlePoll(initialIdleTime) {
    const idleStart = Date.now();
    this._idleTime$.next(initialIdleTime);
    this.idlePollInterval = window.setInterval(() => {
      const delta = Date.now() - idleStart;
      this._idleTime$.next(initialIdleTime + delta);
    }, IDLE_POLL_INTERVAL);
  }

  cancelIdlePoll() {
    if (this.idlePollInterval) {
      window.clearInterval(this.idlePollInterval);
      this._idleTime$.next(0);
    }
  }
}
