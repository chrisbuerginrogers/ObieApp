import threading
import asyncio
import time
from bleak import BleakScanner, BleakClient

# BLE Service and Characteristic UUIDs
SERVICE_UUID = '0000fd02-0000-1000-8000-00805f9b34fb'
WRITE_UUID   = '0000fd02-0001-1000-8000-00805f9b34fb'
NOTIFY_UUID  = '0000fd02-0002-1000-8000-00805f9b34fb'

class BLEManager:
    _ble_lock = threading.Lock()
    
    def __init__(self):        
        self.loop = None
        self.thread = None
        self.device_list = []
        self.scan_callback = self.on_scan_default
        self._initialized = True
        self.device = None
        
        # Track multiple connections
        self.connections = {}  # device_address -> connection_info
        
    def on_scan_default(self, device, adv):
        if SERVICE_UUID.lower() in adv.service_uuids:
            if not any(d.address == device.address for d in self.device_list):
                if device.name:
                    self.device_list.append(device)
                    print('new: ', device)
                 
    def start_ble_thread(self):
        """Start the asyncio event loop in a separate thread"""
        print('starting ble thread')
        if self.thread is None or not self.thread.is_alive():
            self.thread = threading.Thread(target=self.start_event_loop, daemon=True)
            self.thread.start()
            time.sleep(0.1)
    
    def start_event_loop(self):
        """Run the asyncio event loop"""
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()
        
    def _run_coroutine(self, coroutine, timeout):
        """Internal method to run coroutine without locking"""
        future = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        try:
            result = future.result(timeout=timeout)
            return result
        except Exception as e:
            print(f"Coroutine failed: {e}")
            future.cancel()

    def ble_run_it(self, coroutine, timeout=3, use_lock = False):
        """Run any async coroutine synchronously"""
        if self.loop is None:
            self.start_ble_thread()
        
        if use_lock:
            with BLEManager._ble_lock:
                return self._run_coroutine(coroutine, timeout)
        else:
            return self._run_coroutine(coroutine, timeout)
        
    def scan(self, timeout=5.0):
        """Scan for devices"""
        self.device_list = []  # Clear previous results
        
        async def scan_devices(timeout):
            scanner = BleakScanner(detection_callback=self.scan_callback)
            await scanner.start()
            print('scanning...')
            await asyncio.sleep(timeout)
            await scanner.stop()
            
        result = self.ble_run_it(scan_devices(timeout), timeout + 1, use_lock = True)
        return self.device_list

    async def ble_connect(self, device, callback=None):
        """Connect to a specific device"""
        print('connecting')
        client = BleakClient(device, disconnected_callback=self.on_disconnect)
        await client.connect()
        
        service = client.services.get_service(SERVICE_UUID)
        rx_char = service.get_characteristic(WRITE_UUID)
        tx_char = service.get_characteristic(NOTIFY_UUID)
        
        # Store connection info
        self.connections[device.address] = {
            'client': client,
            'device': device,
            'rx_char': rx_char,
            'tx_char': tx_char,
            'callback': callback
        }
        
        if callback:
            await client.start_notify(tx_char, callback)
        
        print(f"Connected to {device.name}")
        return True
    
 
    async def send(self, device_address, message):
        """Send message to specific device"""
        if device_address in self.connections:
            conn = self.connections[device_address]
            await conn['client'].write_gatt_char(conn['rx_char'], message, response=False)

    def is_connected(self, device_address):
        """Check if device is connected"""
        if device_address in self.connections:
            return self.connections[device_address]['client'].is_connected
        return False
    
    def disconnect_device(self, device_address):
        """Disconnect specific device"""
        async def do_disconnect():
            if device_address in self.connections:
                conn = self.connections[device_address]
                if conn['client'].is_connected:
                    await conn['client'].disconnect()
                del self.connections[device_address]
        
        return self.ble_run_it(do_disconnect())
    
    def on_disconnect(self, client):
        """Handle disconnection"""
        print("Connection lost")
        # Find and remove the disconnected client
        for addr, conn in list(self.connections.items()):
            if conn['client'] is client:
                del self.connections[addr]
                break
    
    def close_all(self):
        """Close all connections"""
        async def close_all_connections():
            for addr in list(self.connections.keys()):
                await self.disconnect_device(addr)
            
            if self.loop and not self.loop.is_closed():
                self.loop.stop()
        
        self.ble_run_it(close_all_connections(), 2, use_lock = True)