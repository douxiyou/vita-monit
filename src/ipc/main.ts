import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import Aedes from 'aedes'
import net from 'node:net'
import cluster from 'cluster';
import os from 'os'
import {ProtocolUtils} from './protocol-utils'
import {DeviceManager} from './device-manager'
const numCPUs = os.cpus().length;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}
let mqttServer
const deviceManager = new DeviceManager();
const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true, // 开发阶段开启，生产阶段关闭
      contextIsolation: false // 开发阶段关闭，生产阶段开启
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
  mainWindow.on('closed', () => {
    // 窗口关闭时，停止 MQTT 服务,停止设备管理器
  })
  // Open the DevTools.
  mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
ipcMain.handle('mqtt:start', (_, port) => {
  try {
    startMqttBroker(port);
    return { success: true, port };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('mqtt:stop', () => {
  try {
    mqttServer.close();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('device:getAll', () => {
  return deviceManager.getAllDevices(); // 返回所有设备列表（支持 300 台）
});

ipcMain.handle('log:export', async () => {
  // 导出日志（示例：选择保存路径）
  const { filePath } = await dialog.showSaveDialog({
    title: '导出日志',
    defaultPath: `watch-server-log-${new Date().getTime()}.txt`,
    filters: [{ name: 'Text Files', extensions: ['txt'] }]
  });
  if (filePath) {
    deviceManager.exportLogs(filePath);
    return { success: true, filePath };
  }
  return { success: false };
});
function startMqttBroker(port = 1883) {
  if (cluster.isPrimary) {
    // 主进程：启动多进程（CPU 核心数）
    console.log(`主进程 ${process.pid} 启动，共 ${numCPUs} 个工作进程`);
    for (let i = 0; i < numCPUs; i++) {
      cluster.fork();
    }
    cluster.on('exit', (worker) => {
      console.log(`工作进程 ${worker.process.pid} 退出，重启中...`);
      cluster.fork(); // 进程崩溃自动重启
    });
  } else {
    // 工作进程：创建 MQTT TCP 服务
    mqttServer = net.createServer(Aedes.handle);
    mqttServer.listen(port, () => {
      console.log(`工作进程 ${process.pid} - MQTT Broker 监听端口 ${port}`);
      // 通知渲染进程：MQTT 服务已启动
      if (mainWindow) {
        mainWindow.webContents.send('mqtt:started', { port });
      }
    });

    // 3. MQTT 连接事件：手表接入
    Aedes.on('client', (client) => {
      console.log(`设备连接：${client.id}（进程 ${process.pid}）`);
      // 设备上线：记录 MAC（假设 client.id 为手表 MAC，如 8e:83:c0:22:f6:04）
      deviceManager.addDevice(client.id, {
        clientId: client.id,
        status: 'online',
        connectTime: new Date().toLocaleString(),
        processId: process.pid
      });
      // 通知渲染进程：设备上线
      mainWindow?.webContents.send('device:online', deviceManager.getDevice(client.id));
    });

    // 4. MQTT 消息事件：接收手表上行数据
    Aedes.on('publish', (packet, client) => {
      if (!client || !packet.payload) return;
      const clientId = client.id;
      const hexData = packet.payload.toString('hex'); // 手表发送 16 进制数据
      console.log(`接收数据 [${clientId}]：${hexData}`);

      // 解析上行数据（按文档协议）
      const buffer = Buffer.from(hexData, 'hex');
      const frameType = ProtocolUtils.parseHeader(buffer);
      let parsedResult = null;

      // 按帧类型解析（AA44/AA55/AA77）
      switch (frameType) {
      case ProtocolUtils.FRAME_TYPE.BOOT_VERSION:
        parsedResult = ProtocolUtils.parseBootVersionFrame(buffer);
        break;
      case ProtocolUtils.FRAME_TYPE.HEALTH_DATA:
        parsedResult = ProtocolUtils.parseHealthDataFrame(buffer);
        // 更新设备健康数据
        deviceManager.updateDeviceData(clientId, {
          heartRate: parsedResult?.healthData?.heartRate,
          bloodOxygen: parsedResult?.healthData?.bloodOxygen,
          wristTemp: parsedResult?.healthData?.wristTemp,
          bodyTemp: parsedResult?.healthData?.bodyTemp,
          wearStatus: parsedResult?.healthData?.wearStatus
        });
        break;
      case ProtocolUtils.FRAME_TYPE.ALARM_DATA:
        parsedResult = ProtocolUtils.parseAlarmDataFrame(buffer);
        // 报警数据：标记设备报警状态
        deviceManager.updateDeviceData(clientId, {
          alarm: parsedResult?.alarmType,
          alarmTime: new Date().toLocaleString()
        });
        break;
      default:
        parsedResult = { error: '未知帧类型', rawData: hexData };
      }

      // 通知渲染进程：接收数据
      mainWindow?.webContents.send('data:received', {
        clientId,
        rawData: hexData,
        parsedResult,
        time: new Date().toLocaleString()
      });

      // 5. 生成下行应答帧，发送给手表
      if (parsedResult && !parsedResult.error) {
        const responseFrame = ProtocolUtils.generateResponseFrame(
          clientId.replace(/:/g, ''), // MAC 去掉冒号（文档格式）
          frameType
        );
        if (responseFrame) {
          const responseHex = responseFrame.toString('hex');
          // MQTT 发布应答：主题为 /watch/response/{clientId}（手表订阅此主题）
          Aedes.publish({
            topic: `/watch/response/${clientId}`,
            payload: Buffer.from(responseHex, 'hex'),
            qos: 1, // 确保消息送达（300 并发建议 QoS 1，平衡性能与可靠性）
            retain: false
          });
          console.log(`发送应答 [${clientId}]：${responseHex}`);
          // 通知渲染进程：发送应答
          mainWindow?.webContents.send('data:sent', {
            clientId,
            rawData: responseHex,
            time: new Date().toLocaleString()
          });
        }
      }
    });

    // 6. MQTT 断开事件：手表离线
    Aedes.on('clientDisconnect', (client) => {
      if (!client) return;
      console.log(`设备离线：${client.id}（进程 ${process.pid}）`);
      // 更新设备状态
      deviceManager.updateDeviceData(client.id, { status: 'offline', disconnectTime: new Date().toLocaleString() });
      // 通知渲染进程：设备离线
      mainWindow?.webContents.send('device:offline', deviceManager.getDevice(client.id));
    });
  }
}