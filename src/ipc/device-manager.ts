// src/main/device-manager.js
import fs from 'node:fs'

export class DeviceManager {
  constructor() {
    this.devices = new Map(); // key: MAC，value: 设备信息
    this.logs = []; // 数据日志
  }

  /**
   * 添加设备（上线）
   * @param {string} mac - 设备 MAC
   * @param {object} deviceInfo - 设备信息
   */
  addDevice(mac, deviceInfo) {
    this.devices.set(mac, { ...deviceInfo, healthData: {}, alarm: [] });
    this._addLog(`设备上线：${mac}`, 'info');
  }

  /**
   * 更新设备数据（健康数据/状态）
   * @param {string} mac - 设备 MAC
   * @param {object} data - 待更新数据
   */
  updateDeviceData(mac, data) {
    if (!this.devices.has(mac)) return;
    const device = this.devices.get(mac);
    this.devices.set(mac, { ...device, ...data });
    if (data.alarm) {
      this._addLog(`设备报警 [${mac}]：${data.alarm.join(',')}`, 'alarm');
    }
  }

  /**
   * 获取单台设备信息
   * @param {string} mac - 设备 MAC
   * @returns {object|null} 设备信息
   */
  getDevice(mac) {
    return this.devices.get(mac) || null;
  }

  /**
   * 获取所有设备列表（支持 300 台）
   * @returns {array} 设备列表
   */
  getAllDevices() {
    return Array.from(this.devices.values());
  }

  /**
   * 清理设备（离线/退出时）
   */
  clear() {
    this.devices.clear();
    this._addLog('设备列表已清空', 'info');
  }

  /**
   * 导出日志到文件
   * @param {string} filePath - 保存路径
   */
  async exportLogs(filePath) {
    const logContent = this.logs.map(log =>
      `[${log.time}] [${log.type}] ${log.content}`
    ).join('\n');
    await fs.writeFile(filePath, logContent, 'utf8');
    this._addLog(`日志已导出：${filePath}`, 'info');
  }

  /**
   * 添加日志（私有）
   */
  _addLog(content, type = 'info') {
    this.logs.push({
      time: new Date().toLocaleString(),
      type,
      content
    });
    // 日志上限：10000 条，避免内存溢出
    if (this.logs.length > 10000) {
      this.logs.shift();
    }
  }
}
