import { handleBatteryStepPacket, handleDcStatePacket } from "./battery";
import { handleVolumePacket } from "./volume";
import { handleLampStatePacket } from "./lamp";
import { handleDeviceInfoPacket } from "./device-info";
import { toHex, logLine } from "../utils/formatter";

export type GaiaPacketEvent = {
  address: string;
  vendor_id: number;
  command_id: number;
  command: number;
  ack: boolean;
  flags: number;
  payload: number[];
  status?: number | null;
};

const PT_VENDOR_ID = 0x5054;
const GAIA_STATUS_SUCCESS = 0;

function dispatchPtPacket(address: string, command: number, dataPayload: number[]) {
  switch (command) {
    case 0x0455: handleBatteryStepPacket(address, dataPayload); break;
    case 0x0456: handleDcStatePacket(address, dataPayload); break;
    case 0x0401: handleVolumePacket(address, dataPayload); break;
    case 0x0411: handleLampStatePacket(address, dataPayload); break;
    case 0x0451:
    case 0x0452:
    case 0x0453:
    case 0x0454:
    case 0x0457: handleDeviceInfoPacket(address, command, dataPayload); break;
  }
}

export function handleGaiaPacket(p: GaiaPacketEvent) {
  const dataPayload = p.ack && p.payload.length > 0 ? p.payload.slice(1) : p.payload;
  const isAckSuccess = p.ack && p.status === GAIA_STATUS_SUCCESS;

  if (p.vendor_id === PT_VENDOR_ID && (!p.ack || isAckSuccess)) {
    dispatchPtPacket(p.address, p.command, dataPayload);
  }

  const payloadText = p.payload.length
    ? p.payload.map((b: number) => toHex(b, 2)).join(" ")
    : "<empty>";
  const statusText = p.status !== null && p.status !== undefined ? ` status=${p.status}` : "";
  
  logLine(
    `${toHex(p.vendor_id, 4)} ${toHex(p.command_id, 4)}${p.ack ? " ACK" : ""}${statusText} ${payloadText}`,
    "IN"
  );
}
