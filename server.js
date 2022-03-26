const mediasoup = require('mediasoup');
const fs = require('fs');
const https = require('https');
const express = require('express');
const socketIO = require('socket.io');
const config = require('./config');
const { RoomManager, Room } = require('./lib/RoomManager');

// Global variables
let webServer;
let socketServer;
let expressApp;
let mediasoupRouter;
let defaultRoom = null;

(async () => {
  try {
    RoomManager.initRooms();
    await runExpressApp();
    await runWebServer();
    await runSocketServer();
    await runMediasoupWorker();
  } catch (err) {
    console.error(err);
  }
})();

async function runExpressApp() {
  expressApp = express();
  expressApp.use(express.json());
  expressApp.use(express.static(__dirname));

  expressApp.use((error, req, res, next) => {
    if (error) {
      console.warn('Express app error,', error.message);

      error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

      res.statusMessage = error.message;
      res.status(error.status).send(String(error));
    } else {
      next();
    }
  });
}

async function runWebServer() {
  const { sslKey, sslCrt } = config;
  if (!fs.existsSync(sslKey) || !fs.existsSync(sslCrt)) {
    console.error('SSL files are not found. check your config.js file');
    process.exit(0);
  }
  const tls = {
    cert: fs.readFileSync(sslCrt),
    key: fs.readFileSync(sslKey),
  };
  webServer = https.createServer(tls, expressApp);
  webServer.on('error', (err) => {
    console.error('starting web server failed:', err.message);
  });

  await new Promise((resolve) => {
    const { listenIp, listenPort } = config;
    webServer.listen(listenPort, listenIp, () => {
      const listenIps = config.mediasoup.webRtcTransport.listenIps[0];
      const ip = listenIps.announcedIp || listenIps.ip;
      console.log('server is running');
      console.log(`open https://${ip}:${listenPort} in your web browser`);
      resolve();
    });
  });
}

async function runSocketServer() {
  socketServer = socketIO(webServer, {
    serveClient: false,
    path: '/server',
    log: false,
  });

  socketServer.on('connection', (socket) => {
    console.log('client connected socketId=%s', socket.id);
    const rooms = socketServer.sockets.adapter.rooms;

    socket.on('joinRoom', async (data) => {
      const roomName = data.roomName;
      const room = RoomManager.getRoom(roomName);

      if(room) {
        console.log('Joining existing room %s', roomName);
      } else {
        createRoom(roomName);
        console.log('Creating and joining room %s', roomName);
      }

      await socket.join(roomName);
      socket.roomName = roomName;
    });

    socket.on('fetchRooms', () => {
      console.log('fetchRooms is being called');
      socket.emit('roomsFetched', { availableRooms: RoomManager.getRoomsNames() });
    });

    socket.on('disconnect', () => {
      const clientId = socket.id;

      if(clientId) {
        const roomName = socket.roomName;
        const room = RoomManager.getRoom(roomName);
        const producerTransport = room?.getProducerTransport(socket.id);
        const consumerTransport = room?.getConsumerTransport(socket.id);
        
        if(producerTransport)
          producerTransport.close();
        if(consumerTransport)
          consumerTransport.close();

        socket.leave(roomName);

        console.log(`client ${socket.id} disconnected`);
      }
    });

    socket.on('connect_error', (err) => {
      console.error('client connection error', err);
    });

    socket.on('getRouterRtpCapabilities', (data, callback) => {
      callback(mediasoupRouter.rtpCapabilities);
    });

    socket.on('createProducerTransport', async (data, callback) => {
      const roomName = socket.roomName;

      console.log('createProducerTransport room=%s', roomName);

      try {
        const { transport, params } = await createWebRtcTransport();
        addProducerTransport(roomName, socket.id, transport);

        // Attach observer
        transport.observer.on('close', () => {
          const id = socket.id;
          const producer = getProducer(roomName, id);
          if (producer) {
            producer.close();
            deleteProducer(roomName, id);
          }
          deleteProducerTransport(roomName, id);
          console.log('[Observer API] Producer transport closed');
        });

        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('createConsumerTransport', async (data, callback) => {
      const roomName = socket.roomName;
      console.log('createConsumerTransport room=%s', roomName);

      try {
        const { transport, params } = await createWebRtcTransport();
        addConsumerTransport(roomName, socket.id, transport);

        // Attach observer
        transport.observer.on('close', () => {
          const id = socket.id;
          deleteConsumerSet(roomName, id);
          deleteConsumerTransport(roomName, id);
          console.log('[Observer API] Consumer transport closed');
        });

        callback(params);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('getRoomProducers', async (data, callback) => {
      const roomName = socket.roomName;
      const clientId = data.socketId;

      try {
        const producers = getRemoteProducerIds(roomName, clientId);
        callback(producers);
      } catch (err) {
        console.error(err);
        callback({ error: err.message });
      }
    });

    socket.on('connectProducerTransport', async (data, callback) => {
      const roomName = socket.roomName;
      const transport = getProducerTransport(roomName, socket.id);
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('connectConsumerTransport', async (data, callback) => {
      const roomName = socket.roomName;
      const transport = getConsumerTransport(roomName, socket.id);
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      callback();
    });

    socket.on('produce', async (data, callback) => {
      const roomName = socket.roomName;
      const { kind, rtpParameters } = data;
      const transport = getProducerTransport(roomName, socket.id);
      const producer = await transport.produce({ kind, rtpParameters });
      addProducer(roomName, socket.id, producer);

      // Attach observer
      producer.observer.on('close', () => {
        console.log('[Observer API] Producer closed');
      })
      
      console.log('new producer in room=%s', roomName);
      socket.broadcast.to(roomName).emit('newProducer', { socketId: socket.id, producerId: producer.id, kind: producer.kind });

      callback({ id: producer.id });
    });

    socket.on('consume', async (data, callback) => {
      const roomName = socket.roomName;
      const localId = socket.id;
      const remoteId = data.producerId;
      const transport = getConsumerTransport(roomName, localId);
      const producer = getProducer(roomName, remoteId);
    
      const { consumer, params } = await createConsumer(roomName, transport, producer, data.rtpCapabilities);
      addConsumer(roomName, localId, remoteId, consumer);

      // Attach observer
      consumer.observer.on('close', () => {
        console.log('[Observer API] Consumer closed');
      });
  
      consumer.on('producerclose', () => {
        consumer.close();
        deleteConsumer(roomName, localId, remoteId);

        // TODO: Notify client using websocket
      });
      callback(params);
    });

    socket.on('resume', async (data, callback) => {
      const roomName = socket.roomName;
      const remoteId = data.producerId;

      const consumer = getConsumer(roomName, socket.id, remoteId);
      await consumer.resume();
      callback();
    });
  });
}

async function runMediasoupWorker() {
  let worker = await mediasoup.createWorker({
    logLevel: config.mediasoup.worker.logLevel,
    logTags: config.mediasoup.worker.logTags,
    rtcMinPort: config.mediasoup.worker.rtcMinPort,
    rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
  });

  worker.on('died', () => {
    console.error('mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
    setTimeout(() => process.exit(1), 2000);
  });

  const mediaCodecs = config.mediasoup.router.mediaCodecs;
  mediasoupRouter = await worker.createRouter({ mediaCodecs });

  defaultRoom = createRoom('defaultRoom');
}

async function createWebRtcTransport() {
  const {
    maxIncomingBitrate,
    initialAvailableOutgoingBitrate
  } = config.mediasoup.webRtcTransport;

  const transport = await mediasoupRouter.createWebRtcTransport({
    listenIps: config.mediasoup.webRtcTransport.listenIps,
    enableUdp: true,
    enableTcp: true,
    preferUdp: true,
    initialAvailableOutgoingBitrate,
  });
  if (maxIncomingBitrate) {
    try {
      await transport.setMaxIncomingBitrate(maxIncomingBitrate);
    } catch (error) {
    }
  }
  return {
    transport,
    params: {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters
    },
  };
}

function coalesceRoom(roomName) {
  return roomName ? RoomManager.getRoom(roomName) : defaultRoom;
}

function getProducerTransport(roomName, id) {
  console.log('getProducerTransport room=%s', roomName);
  return coalesceRoom(roomName).getProducerTransport(id);
}

function addProducerTransport(roomName, id, transport) {
  coalesceRoom(roomName).addProducerTransport(id, transport);
  console.log('addProducerTransport room=%s', roomName);
}

function deleteProducerTransport(roomName, id) {
  coalesceRoom(roomName).deleteProducerTransport(id);
  console.log('deleteProducerTransport room=%s', roomName);
}

function getProducer(roomName, id) {
  console.log('getProducer room=%s clientId=%s', roomName, id);
  return coalesceRoom(roomName).getProducer(id);
}

function getRemoteProducerIds(roomName, clientId) {
  console.log('getRemoteProducerIds room=%s clientId=%s', roomName, clientId);
  return coalesceRoom(roomName).getRemoteProducerIds(clientId);
}

function addProducer(roomName, id, producer) {
  coalesceRoom(roomName).addProducer(id, producer);
  console.log('addProducer room=%s id=%s', roomName, id);
}

function deleteProducer(roomName, id) {
  coalesceRoom(roomName).deleteProducer(id);
  console.log('deleteProducer room=%s id=%s', roomName, id);
}

function getConsumerTransport(roomName, id) {
  console.log('getConsumerTransport room=%s id=%s', roomName, id);
  return coalesceRoom(roomName).getConsumerTransport(id);
}

function addConsumerTransport(roomName, id, transport) {
  coalesceRoom(roomName).addConsumerTransport(id, transport);
  console.log('addConsumerTransport room=%s id=%s', roomName, id);
}

function deleteConsumerTransport(roomName, id) {
  coalesceRoom(roomName).deleteConsumerTransport(id);
  console.log('deleteConsumerTransport room=%s id=%s', roomName, id);
}

function getConsumer(roomName, localId, remoteId) {
  console.log('getConsumer room=%s localId=%s remoteId=%s', roomName, localId, remoteId);
  return coalesceRoom(roomName).getConsumer(localId, remoteId);
}

function addConsumer(roomName, localId, remoteId, consumer) {
  coalesceRoom(roomName).addConsumer(localId, remoteId, consumer);
  console.log('addConsumer room=%s localId=%s remoteId=%s', roomName, localId, remoteId);
}

function deleteConsumer(roomName, localId, remoteId) {
  coalesceRoom(roomName).deleteConsumer(localId, remoteId);
  console.log('deleteConsumer room=%s localId=%s remoteId=%s', roomName, localId, remoteId);
}

function deleteConsumerSet(roomName, localId) {
  coalesceRoom(roomName).deleteConsumerSet(localId);
  console.log('deleteConsumerSet room=%s localId=%s', roomName, localId);
}

async function createConsumer(roomName, transport, producer, rtpCapabilities) {

  if(!mediasoupRouter.canConsume({
      producerId: producer.id,
      rtpCapabilities
    })
  ){
    console.error('Cannot consume');
    return;
  }

  let consumer = null;

  try {
    consumer = await transport.consume({
      producerId: producer.id,
      rtpCapabilities,
      paused: producer.kind === 'video'
    });
  } catch (error) {
    console.error('createConsumer failed');
    return;
  }

  return {
    consumer,
    params: {
      producerId: producer.id,
      id: consumer.id,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused
    }
  };
}

function createRoom(roomName) {
  const room = new Room(roomName);
  room.router = mediasoupRouter;
  RoomManager.addRoom(room, roomName);
  return room;
}
