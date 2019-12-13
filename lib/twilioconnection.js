'use strict';

const StateMachine = require('./statemachine');
const { buildLogLevels, makeUUID } = require('./util');
const Log = require('./util/log');
const Timeout = require('./util/timeout');
const { Twilsock } = require('../../twilsock.js');
const { Notifications } = require('twilio-notifications');
const qs = require('qs');

function randomCallSid() {
  let sid = 'CA23';
  for(var i = 0; i < 6; i++) {
    sid += '' + Math.floor(Math.random() * 100000);
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
      try {
        message = JSON.parse(message.data);
      } catch (error) {
        this.emit('error', error);
        return;
      }
      switch (message.type) {
        case 'bad':
          this._handleBad(message);
          break;
        case 'bye':
          // Do nothing.
          break;
        case 'heartbeat':
          this._handleHeartbeat();
          break;
        case 'msg':
          this._handleMessage(message);
          break;
        case 'welcome':
          this._handleWelcome(message);
          break;
        default:
          this._log.debug(`Unknown message type: ${message.type}`);
          this.emit('error', new Error(`Unknown message type: ${message.type}`));
          break;
      }
    });
  }

  /**
   * Handle an incoming "msg" message.
   * @param {{body: object}} message
   * @private
   */
  _handleMessage({ body }) {
    if (this.state !== 'open') {
      return;
    }
    this.emit('message', body);
  }

  /**
   * Send a message to the TCMP server.
   * @param {*} message
   * @private
   */
  _send(message) {
    this._log.debug(`Outgoing: ${message}`);
    console.info(`Outgoing: ${message}`);
    this._roomSid = 'bar';

    const accountSid = 'AC78e8e67fc0246521490fb9907fd0c165';
    const attrs = {
      Identity: 'foo',
      CallSid: randomCallSid(),
    }
    if (this._roomSid) {
      attrs.RoomNameOrSid = this._roomSid;
    }
    console.info('RTRTRTRT', accountSid, this._roomSid, getRoomUrl(accountSid), qs.stringify(attrs));
    console.info(headers);
    console.info(message);
    try {
      this._ts.post(`${getRoomUrl(accountSid)}?${qs.stringify(attrs)}`, headers, message.body)
        .then((a, b, c) => console.info('JJJJJ', a, b, c));
    } catch (error) {
      const reason = 'Failed to send message';
      console.warn(`Closing: ${WS_CLOSE_SEND_FAILED} - ${error}`);
      //this._close({ code: WS_CLOSE_SEND_FAILED, reason });
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
    this._ws.close(WS_CLOSE_NORMAL);
  }

  /**
   * Send a "msg" message.
   * @param {*} body
   * @returns {void}
   */
  sendMessage(body) {
    console.info('ZZZZ', body);
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
