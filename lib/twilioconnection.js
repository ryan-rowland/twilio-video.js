'use strict';

const StateMachine = require('./statemachine');
const { buildLogLevels, makeUUID } = require('./util');
const Log = require('./util/log');
const Timeout = require('./util/timeout');
const { Twilsock } = require('../../twilsock.js');
const { Notifications } = require('twilio-notifications');
const qs = require('qs');
const pad = require('pad-left');
const jwt = require('jsonwebtoken');

function randomCallSid() {
  let sid = 'CA23';
  for(var i = 0; i < 6; i++) {
    sid += pad('' + Math.floor(Math.random() * 100000), 5, '0');
  }
  console.info('randomcallsid', sid);
  return sid;
}

const twilsockOptions = { 
  logLevel: 'info',
  twilsock: { 
    uri: `wss://tsock.dev-us1.twilio.com/v3/wsconnect` 
  },
  tweaks: {
    tweak_key: 'TweakKey-2019',
    debug_info: true
  }
};

const headers = {
  'Accept': 'application/json; charset=utf-8',
  'Content-Type': 'application/json; charset=utf-8',
};

const getRoomUrl = (accountSid, roomSid) => roomSid
  ? `http://video-test.twilio.com/internal/v2/Accounts/${accountSid}/Rooms/${roomSid}`
  : `http://video-test.twilio.com/internal/v2/Accounts/${accountSid}/Rooms`;

const getParticipantUrl = (accountSid, roomSid, participantSid) =>
  `http://video-test.twilio.com/internal/v2/Accounts/${accountSid}/Rooms/${roomSid}/Participants/${participantSid}`;

let nInstances = 0;

/*
  TwilioConnection states
  -----------------------

  +--------------+       +----------+
  |  connecting  | ----> |  closed  |
  +--------------+       +----------+
         |                    ^
         v                    |
     +--------+               |
     |  open  | ---------------
     +--------+
 */

const states = {
  closed: [],
  connecting: ['closed', 'open'],
  open: ['closed']
};

const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_WELCOME_TIMEOUT = 3000;
const WS_CLOSE_HEARTBEATS_MISSED = 3001;
const WS_CLOSE_HELLO_FAILED = 3002;
const WS_CLOSE_SEND_FAILED = 3003;

const toplevel = global.window || global;

/**
 * A {@link TwilioConnection} represents a WebSocket connection
 * to a Twilio Connections Messaging Protocol (TCMP) server.
 * @fires TwilioConnection#close
 * @fires TwilioConnection#error
 * @fires TwilioConnection#message
 * @fires TwilioConnection#open
 */
class TwilioConnection extends StateMachine {
  /**
   * Construct a {@link TwilioConnection}.
   * @param {string} serverUrl - TCMP server url
   * @param {TwilioConnectionOptions} options - {@link TwilioConnection} options
   */
  constructor(serverUrl, options, token) {
    super('connecting', states);

    options = Object.assign({
      Log,
      WebSocket
    }, options);

    const logLevels = buildLogLevels(options.logLevel);
    const log = new options.Log('default', this, logLevels);
    console.info('!!!!!!!!!!!!!!!!!!!@#!@$');
    console.info(jwt.decode(token));
    this._identity = jwt.decode(token).grants.identity;
    const twilsock = new Twilsock(token, 'video', twilsockOptions);
    const notifications = new Notifications(token, {
      twilsockClient: twilsock,
      productId: 'video',
    });

    Object.defineProperties(this, {
      _instanceId: {
        value: ++nInstances
      },
      _log: {
        value: log
      },
      _messageQueue: {
        value: []
      },
      _notifications: {
        value: notifications
      },
      _options: {
        value: options
      },
      _ts: {
        value: twilsock
      }
    });

    this.on('stateChanged', (state, error) => ({
      closed: () => this.emit('close', error),
      open: () => this.emit('open')
    }[state]()));

    this._connect(serverUrl);
  }

  toString() {
    return `[TwilioConnection #${this._instanceId}]`;
  }

  /**
   * Close the {@link TwilioConnection}.
   * @param {{code: number, reason: string}} event
   * @private
   */
  _close({ code, reason }) {
    if (this.state === 'closed') {
      return;
    }
    this._messageQueue.splice(0);

    const log = this._log;
    if (code === WS_CLOSE_NORMAL) {
      log.debug('Closed');
    } else {
      log.warn(`Closed: ${code} - ${reason}`);
    }

    this.transition('closed', null, code !== WS_CLOSE_NORMAL
      ? new Error(`WebSocket Error ${code}: ${reason}`)
      : null);
  }

  /*
   * Connect to the TCMP server.
   * @param {string} serverUrl
   * @private
   */
  _connect(serverUrl) {
    const log = this._log;
    const ts = this._ts;
    ts.connect();

    ts.on('disconnected', event => this._close(event));
    ts.on('connectionError', connectionError =>
      console.log(`Twilsock: connection error ${JSON.stringify(connectionError)}`));

    ts.on('initialized', async initReply => {
      this._notifications.subscribe('twilio.video.room', 'twilsock').then((a, b) => {
        console.info('notification subscribed', a, b);
        this.transition('open');
      });
    });

    ts.on('connected', () => { });

    ts.on('message', (type, message) => {
      console.info(`!!!!Incoming: ${type}, ${message}`);
      console.info(`${JSON.stringify(message)}`);
      this._handleMessage(message);
    });
  }

  /**
   * Handle an incoming "msg" message.
   * @param {{body: object}} message
   * @private
   */
  _handleMessage(message) {
    if (this.state !== 'open') {
      return;
    }
    if (message.sid) {
      this._roomSid = message.sid;
    }
    if (message.name) {
      this._roomName = message.name;
    }
    if (message.participant && message.participant.sid) {
      this._participantSid = message.participant.sid;
    }
    this.emit('message', message);
  }

  /**
   * Send a message to the TCMP server.
   * @param {*} message
   * @private
   */
  _send(message) {
    this._log.debug(`Outgoing: ${message}`);
    console.info(`Outgoing: ${message}`);
    const type = message.body && message.body.type;
    const roomName = message.body && message.body.name;

    const accountSid = 'AC78e8e67fc0246521490fb9907fd0c165';
    const attrs = {
      Identity: this._identity,
      CallSid: randomCallSid(),
    }
    if (roomName || this._roomName || this._roomSid) {
      attrs.RoomNameOrSid = roomName || this._roomName || this._roomSid;
    }
    console.info('RTRTRTRT', accountSid, roomName || this._roomSid, getRoomUrl(accountSid), qs.stringify(attrs));
    console.info(headers);
    let uri = this._roomSid
      ? getRoomUrl(accountSid, this._roomSid)
      : getRoomUrl(accountSid);

    if (type === 'update') {
      uri = getParticipantUrl(accountSid, this._roomSid, this._participantSid);
    }
    const method = type === 'update' ? 'put' : 'post';
    console.info(`Attempting to send type ${type} via method ${method} to ${uri}:`);
    console.info(message);
    try {
      this._ts[method](`${uri}?${qs.stringify(attrs)}`, headers, message.body)
        .then((a, b, c) => console.info('JJJJJ', a, b, c));
    } catch (error) {
      const reason = 'Failed to send message';
      console.warn(`Closing: ${WS_CLOSE_SEND_FAILED} - ${error}`);
    }
  }

  /**
   * Send or enqueue a message.
   * @param {*} message
   * @private
   */
  _sendOrEnqueue(message) {
    if (this.state === 'closed') {
      return;
    }
    const sendOrEnqueue = this.state === 'open'
      ? message => this._send(message)
      : message => this._messageQueue.push(message);

    sendOrEnqueue(message);
  }

  /**
   * Close the {@link TwilioConnection}.
   * @returns {void}
   */
  close() {
    if (this.state === 'closed') {
      return;
    }
    this._sendOrEnqueue({ type: 'bye' });
    this._ts.disconnect(WS_CLOSE_NORMAL);
  }

  /**
   * Send a "msg" message.
   * @param {*} body
   * @returns {void}
   */
  sendMessage(body) {
    this._sendOrEnqueue({ body, type: 'msg' });
  }
}

/**
 * A {@link TwilioConnection} was closed.
 * @event TwilioConnection#close
 * @param {?Error} error - If closed by the client, then this is null
 */

/**
 * A {@link TwilioConnection} received an error from the TCMP server.
 * @event TwilioConnection#error
 * @param {Error} error - The TCMP server error
 */

/**
 * A {@link TwilioConnection} received a message from the TCMP server.
 * @event TwilioConnection#message
 * @param {*} body - Message body
 */

/**
 * A {@link TwilioConnection} completed a hello/welcome handshake with the TCMP server.
 * @event TwilioConnection#open
 */

/**
 * {@link TwilioConnection} options
 * @typedef {object} TwilioConnectionOptions
 * @property {LogLevel} [logLevel=warn] - Log level of the {@link TwilioConnection}
 * @property {number} [maxConsecutiveMissedHeartbeats=5] - Max. number of consecutive "heartbeat" messages that can be missed
 * @property {number} [requestedHeartbeatTimeout=5000] - "heartbeat" timeout (ms) requested by the {@link TwilioConnection}
 * @property {number} [welcomeTimeout=5000] - Time (ms) to wait for the "welcome" message after sending the "hello" message
 */

module.exports = TwilioConnection;
