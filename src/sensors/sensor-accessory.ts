import type { API, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { SensorConfig, SensorType } from '../config.js';

const MODELS: Record<SensorType, string> = {
  occupancy: 'Occupancy Sensor',
  motion: 'Motion Sensor',
  contact: 'Contact Sensor',
  button: 'Button',
};

/** One user-defined sensor as a HomeKit accessory. */
export class SensorAccessory {
  private readonly service: Service;
  private active = false;

  constructor(
    private readonly api: API,
    readonly accessory: PlatformAccessory,
    readonly config: SensorConfig,
  ) {
    const { Characteristic, Service } = api.hap;
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Intermission')
      .setCharacteristic(Characteristic.Model, MODELS[config.type])
      .setCharacteristic(Characteristic.SerialNumber, config.id);

    const type = this.serviceType();
    // A sensor whose type changed keeps its accessory (and Home automations) but swaps the service.
    for (const service of [...accessory.services]) {
      if (service.UUID !== Service.AccessoryInformation.UUID && service.UUID !== type.UUID) {
        accessory.removeService(service);
      }
    }
    this.service = accessory.services.find((service) => service.UUID === type.UUID) ?? accessory.addService(new type(config.name));
    this.service.setCharacteristic(Characteristic.Name, config.name);

    if (config.type === 'button') {
      const press = Characteristic.ProgrammableSwitchEvent;
      this.service.getCharacteristic(press).setProps({ validValues: [press.SINGLE_PRESS] });
    } else {
      this.setActive(false, true);
    }
  }

  get id(): string {
    return this.config.id;
  }

  setActive(active: boolean, force = false): void {
    if (this.config.type === 'button' || (active === this.active && !force)) {
      return;
    }
    this.active = active;
    const { Characteristic } = this.api.hap;
    switch (this.config.type) {
      case 'occupancy':
        this.service.updateCharacteristic(Characteristic.OccupancyDetected, active
          ? Characteristic.OccupancyDetected.OCCUPANCY_DETECTED
          : Characteristic.OccupancyDetected.OCCUPANCY_NOT_DETECTED);
        break;
      case 'motion':
        this.service.updateCharacteristic(Characteristic.MotionDetected, active);
        break;
      case 'contact':
        this.service.updateCharacteristic(Characteristic.ContactSensorState, active
          ? Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : Characteristic.ContactSensorState.CONTACT_DETECTED);
        break;
    }
  }

  press(): void {
    if (this.config.type === 'button') {
      const press = this.api.hap.Characteristic.ProgrammableSwitchEvent;
      this.service.updateCharacteristic(press, press.SINGLE_PRESS);
    }
  }

  private serviceType(): WithUUID<new (displayName?: string) => Service> {
    const { Service } = this.api.hap;
    switch (this.config.type) {
      case 'occupancy':
        return Service.OccupancySensor;
      case 'motion':
        return Service.MotionSensor;
      case 'contact':
        return Service.ContactSensor;
      case 'button':
        return Service.StatelessProgrammableSwitch;
    }
  }
}
