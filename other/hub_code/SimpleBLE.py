import asyncio

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic

SERVICE_UUID = "0000fd02-0000-1000-8000-00805f9b34fb"
WRITE_UUID   = "0000fd02-0001-1000-8000-00805f9b34fb"   # RX - for sending data TO the hub
NOTIFY_UUID  = "0000fd02-0002-1000-8000-00805f9b34fb"   # TX - for receiving data FROM the hub
        
class SimpleBLE():
    def __init__(self, done_callback = None):
        self.device_list = []
        self.client_list = {}
        self.done_callback = done_callback
    
    def on_scan(self, device, adv):
        if SERVICE_UUID.lower() in adv.service_uuids:
            if not any(d.address == device.address for d in self.device_list):
                if device.name:
                    self.device_list.append(device)

    async def scan_devices(self, timeout, name = None):
        try:
            print(f'scanning for {name} in {timeout} sec...')
            self.device_list = []  # Clear previous results
            scanner = BleakScanner(detection_callback=self.on_scan)
            await scanner.start()
            for i in range(100):
                await asyncio.sleep(timeout/100)
                if any(name in d.name for d in self.device_list):
                    break
            await scanner.stop()
            return self.device_list
        except Exception as e:
            print('BLE Scan error: ',e)
            return None
            
    def remote_disconnect(self, device): # this comes from the worker
        self.on_disconnect(self.client_list[device.address]['client'])
        
    def on_disconnect(self, client):  #this comes from the device
        if not self.client_list:
            return
        my_device = next((d for d in self.client_list if client == self.client_list[d]['client']), None)
        if my_device:
            try:
                print(f"Connection to {self.client_list[my_device]['device'].name} lost")
                dis_callback = self.client_list[my_device]['disconnect']
                if dis_callback: dis_callback()
                hope = self.client_list.pop(my_device)
            except Exception as e:
                print('BLE Error: ',e)
            
        if not self.client_list:
            print('closing everything')
            self.close_everything()
        
    def close_everything(self):
        if self.done_callback: self.done_callback()
        
    async def connect(self, device, callback, disconnect_callback):
        print(f"Connecting...")
        try:
            client =  BleakClient(device, disconnected_callback = self.on_disconnect)
            await client.connect()
            success =  client.is_connected # new bleak setup - if you have an older version, use success = await client.is_connected() 

            if success:
                service = client.services.get_service(SERVICE_UUID)
                rx_char = service.get_characteristic(WRITE_UUID)
                tx_char = service.get_characteristic(NOTIFY_UUID)
                self.client_list[device.address] = {
                    'client':client,
                    'device':device,
                    'rx_char': rx_char,
                    'callback': callback,
                    'disconnect': disconnect_callback
                    }
                if callback: await client.start_notify(tx_char, callback)
                print("Connected\n")
            else:
                print('Unable to connect')
            return success
        except Exception as e:
            print('BLE Error: ',e)
            return False

    async def send(self, device, message):
        mydevice = self.client_list[device.address]
        print('sending ',message)
        await mydevice['client'].write_gatt_char(mydevice['rx_char'], message, response=False)

