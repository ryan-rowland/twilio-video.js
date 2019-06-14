/* eslint no-process-env:0 */
'use strict';

const connect = require('../../../lib/connect');
const defaults = require('../../lib/defaults');
const getToken = require('../../lib/token');
const { randomName } = require('../../lib/util');

const isConnectionStateSupported = typeof RTCPeerConnection !== 'undefined'
  && 'connectionState' in RTCPeerConnection.prototype;

describe('dtls', function() {
  // eslint-disable-next-line no-invalid-this
  this.timeout(30000);

  (isConnectionStateSupported ? it : it.skip)('should complete dtls handshake when connecting to a Room', async () => {
    const n = parseInt(process.env.N || '1', 10);
    for (let i = 0; i < n; i++) {
      logIfVerboseMode(`=== Attempt ${i + 1} ===`);
      logIfVerboseMode('');
      await testDtlsHandshake();
    }
  });
});

async function testDtlsHandshake() {
  const identity = randomName();
  const name = randomName();
  const room = await connect(getToken(identity), Object.assign({ name }, defaults));
  const peerConnection = room._signaling._peerConnectionManager._peerConnections.values().next().value._peerConnection;

  logIfVerboseMode('  === Initial states ===');
  logIfVerboseMode('');
  logIfVerboseMode('    Room SID => ', room.sid);
  logIfVerboseMode('    Participant SID => ', room.localParticipant.sid);
  logIfVerboseMode('    Initial connectionState => ', peerConnection.connectionState);
  logIfVerboseMode('    Initial iceConnectionState => ', peerConnection.iceConnectionState);
  logIfVerboseMode('');

  await (peerConnection.connectionState === 'connected' ? Promise.resolve() : new Promise(resolve => {
    peerConnection.addEventListener('connectionstatechange', () => {
      logIfVerboseMode('  === connectionstatechange ===');
      logIfVerboseMode('');
      logIfVerboseMode(`    connectionState => ${peerConnection.connectionState}`);
      logIfVerboseMode(`    iceConnectionState => ${peerConnection.iceConnectionState}`);
      logIfVerboseMode('');
      if (peerConnection.connectionState === 'connected') {
        resolve();
      }
    });
  }));

  room.disconnect();
}

function logIfVerboseMode() {
  if (process.env.VERBOSE) {
    console.log.apply(console, arguments);
  }
}
