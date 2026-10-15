// Launch configuration. The checkpoint is the start of a Bitcoin difficulty period (height % 2016 == 0),
// cross-checked against two independent public sources. Counted heights before coinStart run the clock
// but mint nothing; the bootstrap lottery begins at coinStart.
export const LAUNCH = Object.freeze({
  checkpoint: Object.freeze({
    height: 969696,
    hash: '000000000000000000001e39df127cbab82a824ac43cfcdbf62e59f6a08b9f0b',
    bits: 0x17021ef0,
    time: 1791011796,
    chainwork: '102858850537902330315768350040',
    times: Object.freeze([1791008952, 1791009272, 1791010080, 1791010220, 1791010445, 1791010706, 1791011033, 1791011604, 1791011664, 1791011720, 1791011796]),
  }),
  coinStart: 971559,
});
