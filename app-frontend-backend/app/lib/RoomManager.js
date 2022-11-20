class RoomManager {
  static rooms;

  static initRooms() {
    this.rooms = {};
  }

  static addRoom(room, name) {
    this.rooms[name] = room;
    console.log('-- addRoom name=%s room=%s', name, room);
  }

  static getRoom(name) {
    return this.rooms[name];
  }

  static deleteRoom(name) {
    delete this.rooms[name];
  }

  static getRoomsNames() {
    return Object.keys(this.rooms);
  }

  static getRooms() {
    return this.rooms;
  }
}

class Room {

  constructor(name, description) {
    this.name = name;
    this.description = description || 'No description';
    this.producerTransports = {};
    this.consumerTransports = {};
    this.producers = {};
    this.consumers = {};
    this.consumersSet = {};
    this.router = null;
  }

  getRoomName() {
    return this.name;
  }

  getRoomDescription() {
    return this.description;
  }

  getProducerTransport(id) {
    return this.producerTransports[id];
  }

  addProducerTransport(id, transport) {
    this.producerTransports[id] = transport;
    console.log('-- addProducerTransport room=%s id=%s transport=%s', this.getRoomName(), id, transport);
  }

  setRoomDescription(description) {
    this.description = description;
  }

  deleteProducerTransport(id) {
    delete this.producerTransports[id];
    console.log('-- deleteProducerTransport room=%s id=%s', this.getRoomName(), id);
  }

  getConsumerTransport(id) {
    return this.consumerTransports[id];
  }

  addConsumerTransport(id, transport) {
    this.consumerTransports[id] = transport;
    console.log('-- addConsumerTransport room=%s id=%s transport=%', this.getRoomName(), id, transport);
  }

  deleteConsumerTransport(id) {
    delete this.consumerTransports[id];
    console.log('-- addConsumerTransport room=%s id=%s', this.getRoomName(), id);
  }

  getProducer(id) {
    return this.producers[id];
  }

  getRemoteProducerIds(localId) {
    return Object.keys(this.producers)
      .filter(key => key !== localId)
      .map(key => key);
  }

  addProducer(id, producer) {
    this.producers[id] = producer;
    console.log('-- addProducer room=%s id=%s producer=%s', this.getRoomName(), id, producer);
  }

  deleteProducer(id) {
    delete this.producers[id];
    console.log('-- deleteProducer room=%s id=%s', this.getRoomName(), id);
  }

  getConsumerSet(localId) {
    return this.consumersSet[localId];
  }

  addConsumerSet(localId, consumers) {
    this.consumersSet[localId] = consumers;
  }

  deleteConsumerSet(localId) {
    const consumerSet = this.getConsumerSet(localId);
    delete this.consumersSet[localId];

    if(consumerSet) {
      Object.keys(consumerSet)
        .map(key => consumerSet[key])
        .forEach(consumer => {
          consumer.close();
          delete consumerSet[key];
        });
    }

    console.log('-- deleteConsumerSet room=%s localId=%s', this.getRoomName(), localId);
  }

  getConsumer(localId, remoteId) {
    const consumerSet = this.getConsumerSet(localId);
    return consumerSet[remoteId] || null;
  }

  addConsumer(localId, remoteId, consumer) {
    const consumerSet = this.consumersSet[localId];

    if(consumerSet) {
      consumerSet[remoteId] = consumer;
    } else {
      const newConsumerSet = {};
      newConsumerSet[remoteId] = consumer;
      this.addConsumerSet(localId, newConsumerSet);
    }

    console.log('-- addConsumer room=%s localId=%s remoteId=%s consumer=%s', this.getRoomName(), localId, remoteId, consumer);
  }

  deleteConsumer(localId, remoteId) {
    const consumerSet = this.consumersSet[localId];

    if(consumerSet) {
      delete consumerSet[remoteId];
    }

    console.log('-- deleteConsumer room=%s localId=%s remoteId=%s', this.getRoomName(), localId, remoteId);
  }

}

module.exports = {
  RoomManager,
  Room
}