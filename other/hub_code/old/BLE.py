from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

import asyncio

SPIKE_SERVICE_UUID = "0000fd02-0000-1000-8000-00805f9b34fb"
SPIKE_WRITE_UUID   = "0000fd02-0001-1000-8000-00805f9b34fb"   # RX - for sending data TO the hub
SPIKE_NOTIFY_UUID  = "0000fd02-0002-1000-8000-00805f9b34fb"   # TX - for receiving data FROM the hub


async def main():

    def check_service_uuid(device: BLEDevice, adv: AdvertisementData) -> bool:
        return SPIKE_SERVICE_UUID.lower() in adv.service_uuids

    matching_devices = []
    def device_found_callback(device: BLEDevice, adv: AdvertisementData):
        if True: #check_service_uuid(device, adv):
            # Avoid duplicates (same device might be detected multiple times)
            if not any(d.address == device.address for d in matching_devices):
                matching_devices.append(device)
                print(f"Found hub: {device.name} ({device.address})")

    # Start scanning with callback
    scanner = BleakScanner(detection_callback=device_found_callback)
    await scanner.start()
    await asyncio.sleep(4.0)  # Scan for 4 seconds
    await scanner.stop()

    print(f"\nScan complete. Found {len(matching_devices)} matching hubs:")
    for i, device in enumerate(matching_devices):
        print(f"{i+1}: {device.name or 'Unknown'} ({device.address})")

    return matching_devices    

asyncio.run(main())
