
var dgram = require('dgram');
var cyclist = require('cyclist');
var util = require('util');
var EventEmitter = require('events').EventEmitter;
var stream = require('readable-stream')
var Duplex = stream.Duplex;
var Writable = stream.Writable;
var debug = require('debug')('utp')

var EXTENSION = 0;
var VERSION   = 1;
var UINT16    = 0xffff;
var ID_MASK   = 0xf << 4;
var MTU       = 1400;

var PACKET_DATA  = 0 << 4;
var PACKET_FIN   = 1 << 4;
var PACKET_STATE = 2 << 4;
var PACKET_RESET = 3 << 4;
var PACKET_SYN   = 4 << 4;

var MIN_PACKET_SIZE = 20;
var DEFAULT_WINDOW_SIZE = 1 << 18;
var CLOSE_GRACE = 5000;

var BUFFER_SIZE = 512;

var uint32 = function(n) {
	return n >>> 0;
};

var uint16 = function(n) {
	return n & UINT16;
};

var hrtime = process.hrtime ?
	process.hrtime.bind(process) :
	require('browser-process-hrtime')

var timestamp = function() {
	var offset = hrtime();
	var then = Date.now() * 1000;

	return function() {
		var diff = hrtime(offset);
		return uint32(then + 1000000 * diff[0] + ((diff[1] / 1000) | 0));
	};
}();

var bufferToPacket = function(buffer) {
	var packet = {};
	packet.id = buffer[0] & ID_MASK;
	packet.connection = buffer.readUInt16BE(2);
	packet.timestamp = buffer.readUInt32BE(4);
	packet.timediff = buffer.readUInt32BE(8);
	packet.window = buffer.readUInt32BE(12);
	packet.seq = buffer.readUInt16BE(16);
	packet.ack = buffer.readUInt16BE(18);
	packet.data = buffer.length > 20 ? buffer.slice(20) : null;
	return packet;
};

var packetToBuffer = function(packet) {
	var buffer = new Buffer(20 + (packet.data ? packet.data.length : 0));
	buffer[0] = packet.id | VERSION;
	buffer[1] = EXTENSION;
	buffer.writeUInt16BE(packet.connection, 2);
	buffer.writeUInt32BE(packet.timestamp, 4);
	buffer.writeUInt32BE(packet.timediff, 8);
	buffer.writeUInt32BE(packet.window, 12);
	buffer.writeUInt16BE(packet.seq, 16);
	buffer.writeUInt16BE(packet.ack, 18);
	if (packet.data) packet.data.copy(buffer, 20);
	return buffer;
};

var createPacket = function(connection, id, data) {
	return {
		id: id,
		connection: id === PACKET_SYN ? connection._recvId : connection._sendId,
		seq: connection._seq,
		ack: connection._ack,
		timestamp: timestamp(),
		timediff: 0,
		window: DEFAULT_WINDOW_SIZE,
		data: data,
		sent: 0
	};
};

var Connection = function(options, socket, syn) {
	var self = this;
	Duplex.call(this, {
		allowHalfOpen: false
	});

	this._isServerSide = !!syn
	this.port = this.remotePort = options.port;
	this.host = this.remoteAddress = options.host;
	this.localPort = options.localPort;
	this.localAddress = options.localAddress;
	this.socket = socket;
	this._debug('new connection: ' + JSON.stringify(options))

	this._outgoing = cyclist(BUFFER_SIZE);
	this._incoming = cyclist(BUFFER_SIZE);

	this._inflightPackets = 0;
	this._alive = false;
	this._utpState = {
		ended: false,
		closed: false,
		finished: false
	}

	if (syn) {
		this._connecting = false;
		this._recvId = uint16(syn.connection+1);
		this._sendId = syn.connection;
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = syn.seq;
		this._synack = createPacket(this, PACKET_STATE, null);

		this._transmit(this._synack);
	} else {
		this._connecting = true;
		this._recvId = 0; // tmp value for v8 opt
		this._sendId = 0; // tmp value for v8 opt
		this._seq = (Math.random() * UINT16) | 0;
		this._ack = 0;
		this._synack = null;

		socket.on('listening', function() {
			var addr = self.socket.address();
			self.localPort = addr.port;
			self.localAddress = addr.address;
			self._recvId = socket.address().port; // using the port gives us system wide clash protection
			self._sendId = uint16(self._recvId + 1);
			self._sendOutgoing(createPacket(self, PACKET_SYN, null));
		});

		socket.on('error', function(err) {
			self.emit('error', err);
		});

		if ('localPort' in options) socket.bind(options.localPort);
		else socket.bind();
	}

	;['connect', 'finish', 'end', 'close', 'flush'].forEach(function (event) {
		self.on(event, function () {
			self._debug(event)
		})
	})

	var resend = setInterval(this._resend.bind(this), 500);
	var keepAlive = setInterval(this._keepAlive.bind(this), 10*1000);
	var togoBeforeClose = 2
	this.once('finish', function () {
		self._utpState.finished = true
		checkClose()
	});

	this.once('close', function() {
		if (!syn) socket.close()
		clearInterval(resend);
		clearInterval(keepAlive);
	});

	this.once('end', function() {
		self._utpState.ended = true;
		process.nextTick(function () {
			if (!checkClose()) {
				self.destroy()
			}
		})
	});

	function checkClose () {
		if (--togoBeforeClose === 0) {
			self._closing()
			return true
		}
	}
};

util.inherits(Connection, Duplex);

Connection.prototype._debug = function () {
	var side = this._isServerSide ? 'server' : 'client'
	var local = this.localPort || '[unknown]'
	// var args = [].concat.apply([local + '->' + this.port], arguments)
	var args = [].concat.apply([side, local], arguments)
	return debug.apply(null, args)
}

Connection.prototype.setTimeout = function() {
	// TODO: impl me
};

Connection.prototype.end = function () {
	// TODO: handle [chunk][, encoding][, callback]
	this.destroy()
}

Connection.prototype.push = function (chunk) {
	if (chunk === null) {
		this._utpState.ended = true
		this.resume() // make sure 'end' gets emitted
	}

	return Duplex.prototype.push.apply(this, arguments)
}

Connection.prototype.destroy = function() {
	var self = this

	if (this._destroyed) return// throw new Error('already destroyed')

	this._destroyed = true

	if (this._connecting) {
		this.once('connect', destroy)
		timeout = setTimeout(destroy, CLOSE_GRACE)
	} else {
		destroy()
	}

	function destroy () {
		clearTimeout(self._timeout)
		// 'finish' event has fired already
		// meaning we already sent PACKET_FIN
		if (self._utpState.finished) return

		self._debug('sending FIN')
		self._sendOutgoing(createPacket(self, PACKET_FIN, null));
		self.once('flush', function () {
			if (!self._utpState.finished) {
				Duplex.prototype.end.call(self)
			}
		});

		self._timeout = setTimeout(function () {
			if (!self._utpState.finished) {
				self._debug('timed out, emitting \'finish\'')
				self.emit('finish')
			}

			if (!self._utpState.ended) {
				self._debug('timed out, emitting \'end\'')
				self.emit('end')
			}
		}, CLOSE_GRACE)
	}
};

Connection.prototype.address = function() {
	return {port:this.port, address:this.host};
};

Connection.prototype._read = function() {
	// do nothing...
};

Connection.prototype._write = function(data, enc, callback) {
	if (this._connecting) return this._writeOnce('connect', data, enc, callback);

	while (this._writable()) {
		var payload = this._payload(data);

		this._sendOutgoing(createPacket(this, PACKET_DATA, payload));

		if (payload.length === data.length) return callback();
		data = data.slice(payload.length);
	}

	this._writeOnce('flush', data, enc, callback);
};

Connection.prototype._writeOnce = function(event, data, enc, callback) {
	this.once(event, function() {
		this._write(data, enc, callback);
	});
};

Connection.prototype._writable = function() {
	return this._inflightPackets < BUFFER_SIZE-1;
};

Connection.prototype._payload = function(data) {
	if (data.length > MTU) return data.slice(0, MTU);
	return data;
};

Connection.prototype._resend = function() {
	// if (this._utpState.finished) return
	var offset = this._seq - this._inflightPackets;
	var first = this._outgoing.get(offset);
	if (!first) return;

	var timeout = 500000;
	var now = timestamp();

	if (uint32(first.sent - now) < timeout) return;

	for (var i = 0; i < this._inflightPackets; i++) {
		var packet = this._outgoing.get(offset+i);
		if (uint32(packet.sent - now) >= timeout) this._transmit(packet);
	}
};

Connection.prototype._keepAlive = function() {
	if (this._alive) return this._alive = false;
	this._sendAck();
};

Connection.prototype._closing = function() {
	clearTimeout(this._timeout)
	if (this._utpState.closed) return;
	this._utpState.closed = true;
	process.nextTick(this.emit.bind(this, 'close'));
};

// packet handling

Connection.prototype._recvAck = function(ack) {
	var offset = this._seq - this._inflightPackets;
	var acked = uint16(ack - offset)+1;

	if (acked >= BUFFER_SIZE) return; // sanity check

	for (var i = 0; i < acked; i++) {
		this._outgoing.del(offset+i);
		this._inflightPackets--;
	}

	if (!this._inflightPackets) this.emit('flush');
};

Connection.prototype._recvIncoming = function(packet) {
	if (this._utpState.closed) return;

	if (packet.id === PACKET_SYN && this._connecting) {
		this._debug('received SYN')
		this._transmit(this._synack);
		return;
	}
	if (packet.id === PACKET_RESET) {
		this._debug('received RESET')
		this.push(null);
		this.end();
		this._closing();
		return;
	}
	if (this._connecting) {
		if (packet.id !== PACKET_STATE) return this._incoming.put(packet.seq, packet);

		this._ack = uint16(packet.seq-1);
		this._recvAck(packet.ack);
		this._connecting = false;
		this.emit('connect');

		packet = this._incoming.del(packet.seq);
		if (!packet) return;
	}

	if (uint16(packet.seq - this._ack) >= BUFFER_SIZE) return this._sendAck(); // old packet

	this._recvAck(packet.ack); // TODO: other calcs as well

	if (packet.id === PACKET_STATE) return;
	this._incoming.put(packet.seq, packet);

	while (packet = this._incoming.del(this._ack+1)) {
		this._ack = uint16(this._ack+1);

		if (packet.id === PACKET_DATA) this.push(packet.data);
		if (packet.id === PACKET_FIN) {
			this._debug('received FIN')
			this.push(null);
		}
	}

	this._sendAck();
};

Connection.prototype._sendAck = function() {
	this._transmit(createPacket(this, PACKET_STATE, null)); // TODO: make this delayed
};

Connection.prototype._sendOutgoing = function(packet) {
	this._outgoing.put(packet.seq, packet);
	this._seq = uint16(this._seq + 1);
	this._inflightPackets++;
	this._transmit(packet);
};

Connection.prototype._transmit = function(packet) {
	packet.sent = packet.sent === 0 ? packet.timestamp : timestamp();
	var message = packetToBuffer(packet);
	this._alive = true;
	this.socket.send(message, 0, message.length, this.port, this.host);
};


var Server = function() {
	EventEmitter.call(this);
	this._socket = null;
	this._connections = {};
};

util.inherits(Server, EventEmitter);

Server.prototype.address = function() {
	return this._socket.address();
};

Server.prototype.listenSocket = function(socket, onlistening) {
	this._socket = socket;

	var connections = this._connections;
	var self = this;

	socket.on('message', function(message, rinfo) {
		if (message.length < MIN_PACKET_SIZE) return;
		var packet = bufferToPacket(message);
		var id = rinfo.address+':'+(packet.id === PACKET_SYN ? uint16(packet.connection+1) : packet.connection);

		if (connections[id]) return connections[id]._recvIncoming(packet);
		if (packet.id !== PACKET_SYN) return;

		var addr = socket.address();
		connections[id] = new Connection({
			localPort: addr.port,
			localAddress: addr.address,
			port: rinfo.port,
			host: rinfo.address
		}, socket, packet);

		connections[id].on('close', function() {
			delete connections[id];
		});

		self.emit('connection', connections[id]);
	});

	socket.once('listening', function() {
		self.emit('listening');
	});

	if (onlistening) self.once('listening', onlistening);
}

Server.prototype.listen = function(port, onlistening) {
	if (typeof port === 'object' && typeof port.on === 'function') return this.listenSocket(port, onlistening);
	var socket = dgram.createSocket('udp4');
	this.listenSocket(socket, onlistening);
	socket.bind(port);
};

Server.prototype.close = function(cb) {
	var self = this;

	if (cb) this.once('close', cb);

	var togo = 0;
	var conns = this._connections;
	for (var id in this._connections) {
		var c = conns[id];
		if (c._utpState.closed) continue;

		c.once('close', finish);
		c.destroy();
		togo++;
	}

	if (!togo) finish();

	function finish() {
		if (--togo <= 0) {
			if (self._socket) self._socket.close();

			self.emit('close');
		}
	}
}

exports.createServer = function(onconnection) {
	var server = new Server();
	if (onconnection) server.on('connection', onconnection);
	return server;
};

exports.connect = function(port, host, onconnect) {
	var socket = dgram.createSocket('udp4');
	var options
	if (typeof port === 'number') {
		options = {
			port: port
		}
	}
	else {
		options = port
	}

	if (typeof host === 'function') {
		onconnect = host
		host = null
	}

	options.host = host || options.host || '127.0.0.1';
	var socket = dgram.createSocket('udp4');
	var connection = new Connection(options, socket, null);

	socket.on('message', function(message) {
		if (message.length < MIN_PACKET_SIZE) return;
		var packet = bufferToPacket(message);

		if (packet.id === PACKET_SYN) return;
		if (packet.connection !== connection._recvId) return;

		connection._recvIncoming(packet);
	});

	if (onconnect) {
		connection.once('connect', onconnect)
	}

	return connection;
};
