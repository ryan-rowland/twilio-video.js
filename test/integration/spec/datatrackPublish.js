'use strict';

// const assert = require('assert');

const {
  connect,
  createLocalAudioTrack,
  LocalDataTrack,
} = require('../../../lib');


// const defaults = require('../../lib/defaults');
const getToken = require('../../lib/token');

const {
  participantsConnected,
  randomName,
} = require('../../lib/util');

describe('LocalParticipant', function() {
  // eslint-disable-next-line no-invalid-this
  this.timeout(30000);

  function waitForSometime(message, time = 1000) {
    return new Promise(resolve => setTimeout(() => {
      // eslint-disable-next-line no-console
      console.log(message);
      resolve();
    }, time));
  }

  describe('JSDK-2477 - reproduces issue with data track not getting published in firefox', () => {
    [true, false].forEach((dominantSpeaker) => {
      [0, 5000].forEach((delay) => {
        let rooms = [];
        it('delay: ' + delay + ', dominantSpeaker: ' + dominantSpeaker, async () => {
          // eslint-disable-next-line no-console
          console.log('makarand:  delay: ' + delay + ', dominantSpeaker: ' + dominantSpeaker);
          const roomName = randomName();
          const audioTrack = await createLocalAudioTrack();
          const options = {
            environment: 'prod',
            logLevel: 'DEBUG',
            topology: 'group',
            dominantSpeaker,
            name: roomName,
            networkQuality: false,
            tracks: [audioTrack],
          };

          const aliceRoom = await connect(getToken('Alice'), options);
          await waitForSometime('makarand: Alice Joined Room: ' + aliceRoom.sid, delay);

          const bobRoom = await connect(getToken('Bob'), options);
          await waitForSometime('makarand: Bob Joined Room: ' + bobRoom.sid, 0);

          await participantsConnected(aliceRoom, 1);
          await waitForSometime('makarand: Alice Saw Bob connect', 0);

          await participantsConnected(bobRoom, 1);
          await waitForSometime('makarand: Bob saw Alice connect', 0);

          await aliceRoom.localParticipant.publishTrack(new LocalDataTrack());
          await waitForSometime('makarand: Alice Published Data Track!', 0);
        });

        // eslint-disable-next-line no-invalid-this
        this.afterEach(() => {
          rooms.forEach(room => room.disconnect());
        });
      });
    });
  });
});
