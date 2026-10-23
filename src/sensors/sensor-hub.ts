import type { NamedCommand } from '../commands.js';
import { CommandRunner } from '../commands.js';
import type { SensorConfig } from '../config.js';
import type { ChangeContext, SensorOutput } from '../controller.js';
import { player as markPlayer, title as markTitle } from '../diagnostics.js';
import type { Logger } from '../engine/types.js';
import type { SensorAccessory } from './sensor-accessory.js';

/** Runs a sensor's commands for a change, with what was playing. */
export class CommandHooks {
  private readonly byId: Map<string, NamedCommand>;

  constructor(
    commands: readonly NamedCommand[],
    private readonly runner: CommandRunner,
  ) {
    this.byId = new Map(commands.map((command) => [command.id, command]));
  }

  run(sensor: SensorConfig, change: 'on' | 'off' | 'press', context?: ChangeContext): void {
    if (this.byId.size === 0) {
      return;
    }
    const session = context?.session;
    for (const id of sensor.run[change]) {
      const command = this.byId.get(id);
      if (command) {
        void this.runner.run(command, {
          sensor: sensor.name,
          state: change === 'press' ? 'pressed' : change,
          event: context?.event,
          title: session?.media.title,
          type: session?.media.type,
          library: session?.media.librarySectionTitle,
          player: session?.playerTitle ?? session?.playerId,
          user: session?.user,
        });
      }
    }
  }
}

/**
 * One HomeKit sensor shared by every watched server. Each server's controller gets its own output;
 * a state sensor is on while any server says so ("Nothing playing" only while all agree), and button
 * presses pass straight through.
 */
export class SensorHub {
  /** Servers voting against the sensor's resting state. */
  private readonly votes = new Set<number>();
  /** "Nothing playing" rests on: it turns off when any server is busy. */
  private readonly restsOn: boolean;

  constructor(
    readonly accessory: SensorAccessory,
    private readonly commands: CommandHooks,
    private readonly log: Logger,
  ) {
    this.restsOn = accessory.config.state === 'idle';
  }

  output(server: number): SensorOutput {
    return {
      config: this.accessory.config,
      setActive: (active, context) => {
        if (active !== this.restsOn) {
          this.votes.add(server);
        } else {
          this.votes.delete(server);
        }
        const on = this.restsOn ? this.votes.size === 0 : this.votes.size > 0;
        if (this.accessory.setActive(on)) {
          const session = context?.session;
          this.log.info('%s: %s%s', this.accessory.config.name, on ? 'on' : 'off',
            session ? ` (${markTitle(session.media.title)}, ${markPlayer(session.playerTitle ?? session.playerId)})` : '');
          this.commands.run(this.accessory.config, on ? 'on' : 'off', context);
        }
      },
      press: (context) => {
        this.accessory.press();
        this.commands.run(this.accessory.config, 'press', context);
      },
    };
  }
}
