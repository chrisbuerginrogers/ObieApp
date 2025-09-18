import threading
import asyncio
import time
from bleak import BleakScanner, BleakClient

# BLE Service and Characteristic UUIDs
SERVICE_UUID = '0000fd02-0000-1000-8000-00805f9b34fb'
WRITE_UUID   = '0000fd02-0001-1000-8000-00805f9b34fb'
NOTIFY_UUID  = '0000fd02-0002-1000-8000-00805f9b34fb'

class BLEManager:
    """Manages all things BLE through direct calls and callbacks"""
    _ble_lock = threading.Lock()
    
    def __init__(self):
        self.loop = None
        self.device = None
        self.client = None
        self.thread = None
        self.device_list = []
        self.scan_callback = self.on_scan_default
        
    def on_scan_default(self, device, adv):
        if SERVICE_UUID.lower() in adv.service_uuids:
            if not any(d.address == device.address for d in self.device_list):
                if device.name:
                    self.device_list.append(device)
                    print('new: ',device)
                 
    def start_ble_thread(self):
        """Start the asyncio event loop in a separate thread"""
        print('starting ble thread')
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self.start_event_loop, daemon=True)  # daemon = True means that the thread will end when the main code ends (false means the main code will wait for all threads to end)
            self.thread.start()
            time.sleep(0.1)  # Give the loop time to start
    
    def start_event_loop(self):
        """Run the asyncio event loop"""
        print('starting event loop')
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()
    
    def ble_run_it(self, coroutine, timeout = 3):
        """Run any async coroutine synchronously with a 10 sec timeout"""
        if self.loop is None:
            self.start_ble_thread()
            
        with BLEManager._ble_lock:
            future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
            try:
                return future.result(timeout=timeout)
            except:
                future.cancel()
                return None
            
    def ble_scan(self, timeout = 5.0):
        async def scan_devices(timeout):
            scanner = BleakScanner(detection_callback = self.scan_callback)
            await scanner.start()
            await asyncio.sleep(timeout)
            await scanner.stop()
        result = self.ble_run_it(scan_devices(timeout), timeout + 1)
        return self.device_list

    async def on_disconnect(self, client):
        print("Connection lost")
        if client and client.is_connected:
            await client.disconnect()
        
    async def ble_connect(self, callback):
        print("Connecting...")
        self.client =  BleakClient(self.device, disconnected_callback = self.on_disconnect)
        await self.client.connect()
        self.service = self.client.services.get_service(SERVICE_UUID)
        self.rx_char = self.service.get_characteristic(WRITE_UUID)
        self.tx_char = self.service.get_characteristic(NOTIFY_UUID)
        print("Connected\n")

        if callback: # enable notifications on the hub's TX characteristic
            await self.client.start_notify(self.tx_char, callback)
             
    async def ble_send(self, message):
        await self.client.write_gatt_char(self.rx_char, message, response=False)

    
    def close(self):
        async def close_all():
            if self.loop:
                self.loop.stop()
                try:
                    await self.loop
                except:
                    print('done')
            if self.client:
                await self.on_disconnect(self.client)
        self.ble_run_it(close_all(),1)
