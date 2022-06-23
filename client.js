const mediasoup = require('mediasoup-client');
const socketClient = require('socket.io-client');
const socketPromise = require('./lib/socket.io-promise').promise;
const config = require('./config');

const hostname = window.location.hostname;

let device;
let socket;
let producer;

const $ = document.querySelector.bind(document);
const $_all = document.querySelectorAll.bind(document);
const $fsPublish = $_all('#fs_publish button');
const $fsSubscribe = $_all('#fs_subscribe button');
const $btnWebcam = $('#btn_webcam');
const $btnScreen = $('#btn_screen');
const $btnSubscribe = $('#btn_subscribe');
const $btnAddRoom = $('#btn_add_room');
const $txtWebcam = $('#webcam_status');
const $txtScreen = $('#screen_status');
const $txtSubscription = $('#sub_status');
const $txtLocalDefaultEmpty = $('#local-default-empty-text');
const $txtRemoteDefaultEmpty = $('#remote-default-empty-text');
const $txtCurrentRoom = $('#current_room_name');
const $txtCurrentDescription = $('#current_room_description');
const $roomsList = $('#rooms_list');
const $inputRoomName = $('#room_name');
const $inputRoomDescription = $('#room_description');
const $localDiv = $('#local');
const $remoteDiv = $('#remote');
const $createRoomModal = $('#createRoomModal');
let $txtPublish;

$btnWebcam.addEventListener('click', publish);
$btnScreen.addEventListener('click', publish);
$btnSubscribe.addEventListener('click', subscribe);

// Connect directly when window is ready
window.onload = connect();

// @ts-ignore
if (!navigator.mediaDevices.getDisplayMedia) {
  $txtScreen.innerHTML = 'Not supported';
  $btnScreen.disabled = true;
}

async function tryFetchingRooms() {
  if(socket) {
    socket.emit('fetchRooms');
  } else {
    console.log('Trying to fetch rooms...');
    setTimeout(() => tryFetchingRooms(), 2000);
  }
}

async function connect() {
  const opts = {
    path: '/server',
    transports: ['websocket'],
  };

  const serverUrl = `https://${hostname}:${config.listenPort}`;
  socket = socketClient(serverUrl, opts);
  socket.request = socketPromise(socket);

  socket.on('connect', async () => {
    const data = await socket.request('getRouterRtpCapabilities');
    await loadDevice(data);
    await tryFetchingRooms();
    const preselectedRoom = getPreselectedRoomFromCurrentLocation();
    if(preselectedRoom) {
      socket.emit('joinRoom', { roomId: preselectedRoom, roomName: preselectedRoom, socketId: socket.id  });
      showToast('success', 'Connected', `You have joined room <b>${preselectedRoom}</b>`);
      setAllButtonsStatusFromList($fsPublish, false);
      setAllButtonsStatusFromList($fsSubscribe, false);
    }
    $btnAddRoom.addEventListener('click', () => addRoom(socket));
  });

  socket.on('roomsFetched', (data) => {
    displayRooms(data);
  });

  socket.on('disconnect', () => {
    console.log(data);
    setAllButtonsStatusFromList($fsPublish, true);
    setAllButtonsStatusFromList($fsSubscribe, true);
  });

  socket.on('connect_error', (error) => {
    console.error('could not connect to %s%s (%s)', serverUrl, opts.path, error.message);
  });

  socket.on('newProducer', () => {
    setAllButtonsStatusFromList($fsSubscribe, false);
  });

  socket.on('newParticipant', (data) => {
    console.log(data);
  }); 
}

async function loadDevice(routerRtpCapabilities) {
  try {
    device = new mediasoup.Device();
  } catch (error) {
    if (error.name === 'UnsupportedError') {
      console.error('browser not supported');
    }
  }
  await device.load({ routerRtpCapabilities });
}

async function publish(e) {
  const isWebcam = (e.target.id === 'btn_webcam');
  $txtPublish = isWebcam ? $txtWebcam : $txtScreen;

  const data = await socket.request('createProducerTransport', {
    forceTcp: false,
    rtpCapabilities: device.rtpCapabilities,
  });

  if (data.error) {
    console.error(data.error);
    return;
  }

  const transport = device.createSendTransport(data);
  transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
    socket.request('connectProducerTransport', { dtlsParameters })
      .then(callback)
      .catch(errback);
  });

  transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
    try {
      const { id } = await socket.request('produce', {
        socketId: socket.id,
        transportId: transport.id,
        kind,
        rtpParameters,
      });
      callback({ id });
    } catch (err) {
      console.error(err);
      errback(err);
    }
  });

  transport.on('connectionstatechange', (state) => {
    switch (state) {
      case 'connecting':
        setAllButtonsStatusFromList($fsPublish, true);
        setAllButtonsStatusFromList($fsSubscribe, true);
        showToast('info', 'Publish' ,'Publishing...');
      break;

      case 'connected':
        const newVideo = createVideo(stream);
        $txtLocalDefaultEmpty.classList.add('invisible');
        $localDiv.append(newVideo);
        setAllButtonsStatusFromList($fsPublish, true);
        setAllButtonsStatusFromList($fsSubscribe, false);
        showToast('info', 'Publish', 'You are now publishing!');
      break;

      case 'failed':
        transport.close();
        setAllButtonsStatusFromList($fsPublish, false);
        setAllButtonsStatusFromList($fsSubscribe, true);
        showToast('error', 'Connection status', 'An error happened while connecting');
      break;

      default: break;
    }
  });

  let stream;
  try {
    stream = await getUserMedia(transport, isWebcam);
    const track = stream.getVideoTracks()[0];
    const params = { track };
    // if ($chkSimulcast.checked) {
    //   params.encodings = [
    //     { maxBitrate: 100000 },
    //     { maxBitrate: 300000 },
    //     { maxBitrate: 900000 },
    //   ];
    //   params.codecOptions = {
    //     videoGoogleStartBitrate : 1000
    //   };
    // }
    producer = await transport.produce(params);
  } catch (err) {
    $txtPublish.innerHTML = 'failed';
  }
}

async function getUserMedia(transport, isWebcam) {
  if (!device.canProduce('video')) {
    console.error('cannot produce video');
    return;
  }

  let stream;
  try {
    stream = isWebcam ?
      await navigator.mediaDevices.getUserMedia({ video: true }) :
      await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (err) {
    console.error('getUserMedia() failed:', err.message);
    throw err;
  }
  return stream;
}

async function subscribe() {
  const data = await socket.request('createConsumerTransport', {
    forceTcp: false,
    socketId: socket.id
  });

  const producers = await socket.request('getRoomProducers', {
    socketId: socket.id
  });

  if (data.error) {
    console.error(data.error);
    return;
  }

  producers.forEach(producer => {
    const transport = device.createRecvTransport(data);

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      socket.request('connectConsumerTransport', {
        transportId: transport.id,
        dtlsParameters
      })
        .then(callback)
        .catch(errback);
    });

    transport.on('connectionstatechange', async (state) => {
      switch (state) {
        case 'connecting':
          $txtSubscription.innerHTML = 'subscribing...';
          setAllButtonsStatusFromList($fsSubscribe, true);
          break;

        case 'connected':
          const newVideo = await createVideoAndAwait(stream);
          $txtRemoteDefaultEmpty.classList.add('invisible');
          $remoteDiv.append(newVideo);
          await socket.request('resume', { producerId: producer });
          $txtSubscription.innerHTML = 'subscribed';
          setAllButtonsStatusFromList($fsSubscribe, true);
          break;

        case 'failed':
          transport.close();
          $txtSubscription.innerHTML = 'failed';
          setAllButtonsStatusFromList($fsSubscribe, false);
          break;

        default: break;
      }
    });

    const stream = consume(transport, producer);
  });
}

async function consume(transport, producer) {
  const { rtpCapabilities } = device;
  const consumer = await socket.request('consume', { rtpCapabilities, socketId: socket.id, producerId: producer });
  const stream = await createStreamFromConsumerData(consumer, transport);

  return stream;
}

async function createStreamFromConsumerData(data, transport) {
  const {
    producerId,
    id,
    kind,
    rtpParameters,
  } = data;

  let codecOptions = {};
  const consumer = await transport.consume({
    id,
    producerId,
    kind,
    rtpParameters,
    codecOptions,
  });
  const stream = new MediaStream();
  stream.addTrack(consumer.track);
  return stream;
}

function displayRooms({ availableRooms }) {  
  availableRooms.forEach((room) => {
    $roomsList.innerHTML += `<li>${room.name} <span>
      <button id="btn_connect_room-${room.name}" class="btn_connect_room btn btn-primary btn-sm" room-id="${room.name}" room-name="${room.name}" room-description="${room.description}"><i class="bi bi-door-open-fill"></i> Connect</button>
      <button id="btn_copy_room_link-${room.name}" room-url="${location.href.replace(location.search, '')}?room=${room.name}" class="btn btn-light btn-sm" data-bs-toggle="tooltip" data-bs-placement="right" title="Copy room link"><i class="bi bi-link-45deg"></i></button></span></li>`;
  });
    

  availableRooms.map((room) => {
    $(`#btn_connect_room-${room.name}`).addEventListener('click', joinRoom);
    $(`#btn_copy_room_link-${room.name}`).addEventListener('click', copyRoomLink);
  }); 
}

async function joinRoom(event) {
  const roomId = event.target.getAttribute('room-id');
  const roomName = event.target.getAttribute('room-name');
  const roomDescription = event.target.getAttribute('room-description');
  const roomButton = $(`#btn_connect_room-${roomId}`);

  if(socket) {
    socket.emit('joinRoom', { roomId, roomName, socketId: socket.id  });
    setAllButtonsStatusFromList($fsPublish, false);
    setAllButtonsStatusFromList($fsSubscribe, false);
    toggleLateralMenu();
    showToast('success', 'Connected', `You have joined room <b>${roomName}</b>`);
    roomButton.disabled = true;
    setCurrentRoom({ roomName, roomDescription });
  } else {
    console.error(`Socket is not available and cannot connect to room ${roomName}`);
    showToast('error', 'Could not connect', `An error happened while trying to join the room <b>${roomName}</b>`);
  }
  
}

function setAllButtonsStatusFromList (buttonsList, disabled) {
  [...buttonsList].forEach(button => button.disabled = disabled);
}

function showToast(status, title, message) {
  const toastBadgeClass = {
    'success': 'badge bg-success',
    'error': 'badge bg-danger',
    'info': 'badge bg-info'
  };
  const toastLiveExample = $('#liveToast');
  const toastStatus = $('#toast-status');
  const toastTitle = $('#toast-title');
  const toastBody = $('#toast-body');

  toastStatus.classList = toastBadgeClass[status];
  toastStatus.innerHTML = status;
  toastTitle.innerHTML = ' ' + title;
  toastBody.innerHTML = ' ' + message;
  const toast = new bootstrap.Toast(toastLiveExample)
  toast.show();
}

function toggleLateralMenu() {
  const lateralMenu = $('#offcanvasRooms');
  const lateralMenuBackdrop = $('.offcanvas-backdrop');
  const isLateralMenuActive = lateralMenu.classList.contains('show');
  
  if(isLateralMenuActive) {
    lateralMenu.classList.remove("show");
    lateralMenuBackdrop.classList.remove("show");
  } else {
    lateralMenu.classList.add("show");
    lateralMenuBackdrop.classList.add("show");
  }
}

function toggleCreateRoomModal() {
  const isCreateRoomModalActive = $createRoomModal.classList.contains('show');
  const offcanvasBackdrop = $('.offcanvas-backdrop');
  const modalBackdrop = $('.modal-backdrop');
  
  if(isCreateRoomModalActive) {
    $createRoomModal.classList.remove("show");
    offcanvasBackdrop.parentElement.removeChild(offcanvasBackdrop);
    modalBackdrop.parentElement.removeChild(modalBackdrop);
  } else {
    $createRoomModal.classList.add("show");
  }
}

async function createVideoAndAwait(stream) {
  const newVideo = createVideoElement();
  newVideo.srcObject = await stream;
  return newVideo;
}

function createVideo(stream) {
  const newVideo = createVideoElement();
  newVideo.srcObject = stream;
  return newVideo;
}

function createVideoElement() {
  const newVideo = document.createElement('video');
  newVideo.setAttribute('controls', true);
  newVideo.setAttribute('autoplay', true);
  newVideo.setAttribute('playsinline', true);
  return newVideo;
}

function copyRoomLink(event) {
  const roomUrl = event.currentTarget.getAttribute('room-url');
  navigator.clipboard.writeText(roomUrl);
  toggleLateralMenu();
  showToast('info', 'Copied to clipboard', `Room connection link <b>${roomUrl || ''}</b> has been copied`);
}

function getPreselectedRoomFromCurrentLocation() {
  const params = (new URL(document.location)).searchParams;
  return params.get("room");
}

function addRoom(socket) {
  const roomName = $inputRoomName.value;
  const roomDescription = $inputRoomDescription.value;
  socket.emit('joinRoom', { roomId: roomName, roomName, roomDescription, socketId: socket.id  });
  setCurrentRoom({ roomName, roomDescription });
  showToast('success', 'Connected', `You have joined room <b>${roomName}</b>`);
  setAllButtonsStatusFromList($fsPublish, false);
  setAllButtonsStatusFromList($fsSubscribe, false);
  toggleLateralMenu();
  toggleCreateRoomModal();
}

function setCurrentRoom({ roomName, roomDescription }) {
  $txtCurrentRoom.innerHTML = roomName;
  $txtCurrentDescription.innerHTML = roomDescription;
}
