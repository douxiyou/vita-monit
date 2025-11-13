// src/main/protocol-utils.js
import {Buffer} from 'buffer'

export class ProtocolUtils {
  // 帧类型常量（文档 2.1-2.4 章节）
  static FRAME_TYPE = {
    BOOT_VERSION: 0xAA44, // 开机上传版本号
    HEALTH_DATA: 0xAA55,  // 设备健康/定位数据
    ALARM_DATA: 0xAA77    // 报警数据
  };

  // 应答状态（文档 3.1-3.3 章节）
  static RESPONSE_STATUS = {
    FAIL: 0x00,
    SUCCESS: 0x01
  };

  // 升级状态（文档 3.1 章节）
  static UPGRADE_STATUS = {
    NO_UPGRADE: 0x00,
    NEED_UPGRADE: 0x01
  };

  // 包尾（文档所有帧均为 0x0D）
  static PACKET_TAIL = 0x0D;

  /**
   * 解析包头（判断帧类型）
   * @param {Buffer} buffer - 数据帧 Buffer
   * @returns {number|null} 帧类型（如 0xAA44）
   */
  static parseHeader(buffer) {
    if (buffer.length < 2) return null;
    return buffer.readUInt16BE(0); // 大端模式（文档默认）
  }

  /**
   * 解析开机版本号帧（0xAA44，文档 2.1）
   * @param {Buffer} buffer - 完整帧 Buffer
   * @returns {object|null} 解析结果
   */
  static parseBootVersionFrame(buffer) {
    if (buffer.length !== 12 || buffer[11] !== this.PACKET_TAIL) return null;
    return {
      frameType: this.FRAME_TYPE.BOOT_VERSION,
      mac: this._parseMAC(buffer.slice(2, 8)), // 2-7 字节为 MAC
      softwareVersion: buffer.slice(8, 11).toString('ascii'), // 8-10 字节为版本号（ASCII）
      rawData: buffer.toString('hex')
    };
  }

  /**
   * 解析健康数据帧（0xAA55，文档 2.2+2.3）
   * @param {Buffer} buffer - 完整帧 Buffer
   * @returns {object|null} 解析结果（含 AA66 健康块）
   */
  static parseHealthDataFrame(buffer) {
    if (buffer.length < 13 || buffer[buffer.length - 1] !== this.PACKET_TAIL) return null;
    // 基础字段（2-11 字节）
    const baseInfo = {
      frameType: this.FRAME_TYPE.HEALTH_DATA,
      mac: this._parseMAC(buffer.slice(2, 8)),
      battery: buffer.readUInt8(8), // 第 9 字节：电量（十进制）
      packetSeq: buffer.readUInt8(9), // 第 10 字节：包序号
      packetLength: buffer.readUInt16BE(10), // 第 11-12 字节：包长度（大端）
      rawData: buffer.toString('hex')
    };
    // 解析 AA66 健康块（12 字节后，包尾前）
    const healthBlock = buffer.slice(12, buffer.length - 1);
    if (healthBlock.length < 24) return baseInfo; // 健康块至少 24 字节（文档 2.3）

    baseInfo.healthData = {
      timestamp: this._parseTimestamp(healthBlock.slice(2, 6)), // 2-5 字节：时间戳
      frameCount: healthBlock.readUInt32BE(6), // 6-9 字节：帧计数
      heartRate: healthBlock.readUInt8(10), // 第 11 字节：心率
      bloodOxygen: healthBlock.readUInt8(11), // 第 12 字节：血氧
      wearStatus: this._parseWearStatus(healthBlock.readUInt8(12)), // 第 13 字节：佩戴状态
      wristTemp: this._parseTemperature(healthBlock.slice(13, 17)), // 13-16 字节：腕温
      bodyTemp: this._parseTemperature(healthBlock.slice(17, 21)), // 17-20 字节：体温
      wifiMac: this._parseMAC(healthBlock.slice(21, 27)) // 21-26 字节：WiFi MAC
    };
    return baseInfo;
  }

  /**
   * 解析报警数据帧（0xAA77，文档 2.4）
   * @param {Buffer} buffer - 完整帧 Buffer
   * @returns {object|null} 解析结果
   */
  static parseAlarmDataFrame(buffer) {
    if (buffer.length < 13 || buffer[buffer.length - 1] !== this.PACKET_TAIL) return null;
    const baseInfo = {
      frameType: this.FRAME_TYPE.ALARM_DATA,
      mac: this._parseMAC(buffer.slice(2, 8)),
      packetLength: buffer.readUInt16BE(8), // 9-10 字节：包长度
      alarmType: this._parseAlarmType(buffer.readUInt8(10)), // 第 11 字节：报警类型
      rawData: buffer.toString('hex')
    };
    // 可选健康块（11 字节后）
    const healthBlock = buffer.slice(11, buffer.length - 1);
    if (healthBlock.length >= 24) {
      baseInfo.healthData = {
        heartRate: healthBlock.readUInt8(10),
        bloodOxygen: healthBlock.readUInt8(11),
        wearStatus: this._parseWearStatus(healthBlock.readUInt8(12))
      };
    }
    return baseInfo;
  }

  /**
   * 生成下行应答帧（文档 3.1-3.3）
   * @param {string} mac - 设备 MAC（无冒号，如 8e83c022f604）
   * @param {number} frameType - 上行帧类型
   * @returns {Buffer|null} 应答帧 Buffer
   */
  static generateResponseFrame(mac, frameType) {
    const macBuffer = Buffer.from(mac, 'hex');
    let responseBuffer;

    switch (frameType) {
      // 应答开机版本帧（AA44，文档 3.1）
    case this.FRAME_TYPE.BOOT_VERSION:
      responseBuffer = Buffer.concat([
        Buffer.from([0xAA, 0x44]), // 包头
        macBuffer,                 // MAC（6 字节）
        Buffer.from([this.UPGRADE_STATUS.NO_UPGRADE]), // 默认无需升级
        Buffer.from([0x00]),       // URL 长度（0=无 URL）
        Buffer.from([this.PACKET_TAIL]) // 包尾
      ]);
      break;
      // 应答健康数据帧（AA55，文档 3.2）
    case this.FRAME_TYPE.HEALTH_DATA:
      responseBuffer = Buffer.concat([
        Buffer.from([0xAA, 0x55]), // 包头
        macBuffer,                 // MAC（6 字节）
        Buffer.from([this.RESPONSE_STATUS.SUCCESS]), // 接收成功
        Buffer.from([this.PACKET_TAIL]) // 包尾
      ]);
      break;
      // 应答报警数据帧（AA77，文档 3.3）
    case this.FRAME_TYPE.ALARM_DATA:
      responseBuffer = Buffer.concat([
        Buffer.from([0xAA, 0x77]), // 包头
        macBuffer,                 // MAC（6 字节）
        Buffer.from([this.RESPONSE_STATUS.SUCCESS]), // 接收成功
        Buffer.from([this.PACKET_TAIL]) // 包尾
      ]);
      break;
    default:
      responseBuffer = null;
    }
    return responseBuffer;
  }

  // -------------------------- 私有工具方法 --------------------------
  /**
   * 解析 MAC 地址（6 字节→xx:xx:xx:xx:xx:xx）
   */
  static _parseMAC(macBuffer) {
    return Array.from(macBuffer)
      .map(byte => byte.toString('hex').padStart(2, '0'))
      .join(':');
  }

  /**
   * 解析时间戳（4 字节大端→小端→十进制→格式化时间，文档 2.3）
   */
  static _parseTimestamp(timestampBuffer) {
    const timestamp = timestampBuffer.readUInt32LE(0); // 大端转小端
    return new Date(timestamp * 1000).toLocaleString('zh-CN');
  }

  /**
   * 解析温度（4 字节大端→十进制→除以 10，支持正负，文档 2.3）
   */
  static _parseTemperature(tempBuffer) {
    const temp = tempBuffer.readInt32BE(0);
    return temp / 10;
  }

  /**
   * 解析佩戴状态（bit0=1 佩戴，0 未佩戴，文档 2.3）
   */
  static _parseWearStatus(statusByte) {
    return (statusByte & 0x01) === 0x01 ? '已佩戴' : '未佩戴';
  }

  /**
   * 解析报警类型（bit0=低电量，bit1=SOS，文档 2.4）
   */
  static _parseAlarmType(alarmByte) {
    const alarms = [];
    if (alarmByte & 0x01) alarms.push('低电量报警');
    if (alarmByte & 0x02) alarms.push('SOS报警');
    return alarms.length > 0 ? alarms : ['未知报警'];
  }
}
