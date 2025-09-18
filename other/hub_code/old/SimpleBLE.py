# from https://github.com/LEGO/spike-prime-docs/blob/main/examples/python/app.py
import asyncio
from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

SPIKE_SERVICE_UUID = "0000fd02-0000-1000-8000-00805f9b34fb"
SPIKE_WRITE_UUID   = "0000fd02-0001-1000-8000-00805f9b34fb"   # RX - for sending data TO the hub
SPIKE_NOTIFY_UUID  = "0000fd02-0002-1000-8000-00805f9b34fb"   # TX - for receiving data FROM the hub
        
class SimpleBLE():
    def __init__(self):
        self.stop_event = asyncio.Event()
        self.client = None
    
    async def scan(self, timeout = 10):
        print(f"\nScanning for {timeout} seconds for the first hub seen.  please wait...")
        
        def check_service_uuid(device: BLEDevice, adv: AdvertisementData) -> bool:
            return SPIKE_SERVICE_UUID.lower() in adv.service_uuids
        
        self.device = await BleakScanner.find_device_by_filter(filterfunc = check_service_uuid, timeout=timeout)
        print(f"Hub detected: {self.device}")
        return self.device

    async def on_disconnect(self, client):
        print("Connection lost")
        if client and client.is_connected:
            await client.disconnect()
        self.stop_event.set()
        
    async def connect(self, callback):
        print("Connecting...")
        self.client =  BleakClient(self.device, disconnected_callback = self.on_disconnect)
        await self.client.connect()
        self.service = self.client.services.get_service(SPIKE_SERVICE_UUID)
        self.rx_char = self.service.get_characteristic(SPIKE_WRITE_UUID)
        self.tx_char = self.service.get_characteristic(SPIKE_NOTIFY_UUID)
        print("Connected\n")

        if callback: # enable notifications on the hub's TX characteristic
            await self.client.start_notify(self.tx_char, callback)
         
    async def send(self, message):
        await self.client.write_gatt_char(self.rx_char, message, response=False)

            
            