import threading
import asyncio
import time
from bleak import BleakScanner, BleakClient

# BLE Service and Characteristic UUIDs
SERVICE_UUID = '0000fd02-0000-1000-8000-00805f9b34fb'
WRITE_UUID   = '0000fd02-0001-1000-8000-00805f9b34fb'
NOTIFY_UUID  = '0000fd02-0002-1000-8000-00805f9b34fb'

class BLEManager:
    
    def __init__(self):        
        self.device_list = []
        self.scan_callback = self.on_scan_default
        self.device = None
        
        # Track multiple connections
        self.connections = {}  # device_address -> connection_info
        
    def on_scan_default(self, device, adv):
        if SERVICE_UUID.lower() in adv.service_uuids:
            if not any(d.address == device.address for d in self.device_list):
                if device.name:
                    self.device_list.append(device)
                    print('new: ', device)
            
    async def scan(self, timeout=5.0):
        """Scan for devices"""
        self.device_list = []  # Clear previous results
        scanner = BleakScanner(detection_callback=self.scan_callback)
        await scanner.start()
        print('scanning...')
        await asyncio.sleep(timeout)
        await scanner.stop()
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
    
    async def disconnect_device(self, device_address):
        """Disconnect specific device"""
        if device_address in self.connections:
            conn = self.connections[device_address]
            if conn['client'].is_connected:
                await conn['client'].disconnect()
            del self.connections[device_address]
    
    def on_disconnect(self, client):
        """Handle disconnection"""
        print("Connection lost")
        # Find and remove the disconnected client
        for addr, conn in list(self.connections.items()):
            if conn['client'] is client:
                del self.connections[addr]
                break
    
    async def close_all(self):
        """Close all connections"""
        for addr in list(self.connections.keys()):
            await self.disconnect_device(addr)
