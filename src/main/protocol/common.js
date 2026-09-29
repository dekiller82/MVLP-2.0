'use strict';

const PAYLOAD_LEN_SIZE = 2;
const PAYLOAD_CMD_SIZE = 2;

/**
 * Wraps a command + data blob in the iPixel BLE frame:
 * [ length(u16 LE) ][ command(u16 LE) ][ data... ]
 * where `length` is the size of the whole frame, i.e. it includes its own
 * two bytes (matches the original Python and pypixelcolor).
 */
function makePayload(command, data = Buffer.alloc(0)) {
  const length = PAYLOAD_LEN_SIZE + PAYLOAD_CMD_SIZE + data.length;
  const header = Buffer.alloc(PAYLOAD_LEN_SIZE + PAYLOAD_CMD_SIZE);
  header.writeUInt16LE(length, 0);
  header.writeUInt16LE(command, PAYLOAD_LEN_SIZE);
  return Buffer.concat([header, data]);
}

const WRITE_CHARACTERISTIC_UUID = '0000fa02-0000-1000-8000-00805f9b34fb';
const SERVICE_UUID = '0000fa00-0000-1000-8000-00805f9b34fb';

module.exports = { makePayload, WRITE_CHARACTERISTIC_UUID, SERVICE_UUID };
