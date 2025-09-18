import threading
import queue
import time
import struct
import asyncio
from SpikePrime import *
from collections import deque

from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

SERVICE_UUID = "0000fd02-0000-1000-8000-00805f9b34fb"
WRITE_UUID   = "0000fd02-0001-1000-8000-00805f9b34fb"   # RX - for sending data TO the hub
NOTIFY_UUID  = "0000fd02-0002-1000-8000-00805f9b34fb"   # TX - for receiving data FROM the hub
        
class SimpleBLE():
    def __init__(self, request_queue):
        self.stop_event = asyncio.Event()
        self.client = None
        self.device_list = []
        self.result_queue = None
        self.request_queue = request_queue
    
    def on_scan(self, device, adv):
        if SERVICE_UUID.lower() in adv.service_uuids:
            if not any(d.address == device.address for d in self.device_list):
                if device.name:
                    self.device_list.append(device)
                    #print('new: ', device)
                    if self.result_queue: self.result_queue.put(device)

    async def scan_devices(self, timeout, queue = None):
        print(f'scanning for {timeout} sec')
        self.result_queue = queue
        self.device_list = []  # Clear previous results
        scanner = BleakScanner(detection_callback=self.on_scan)
        await scanner.start()
        print('scanning...')
        await asyncio.sleep(timeout)
        await scanner.stop()
        return self.device_list
            
    def on_disconnect(self, client):
        print("Connection lost")
        self.stop_event.set()
        self.request_queue.put('done')
        
    async def connect(self, device, callback):
        print("Connecting...")
        self.client =  BleakClient(device, disconnected_callback = self.on_disconnect)
        await self.client.connect()
        self.service = self.client.services.get_service(SERVICE_UUID)
        self.rx_char = self.service.get_characteristic(WRITE_UUID)
        self.tx_char = self.service.get_characteristic(NOTIFY_UUID)
        print("Connected\n")

        if callback: # enable notifications on the hub's TX characteristic
            await self.client.start_notify(self.tx_char, callback)
            
        
         
    async def send(self, message):
        await self.client.write_gatt_char(self.rx_char, message, response=False)

          
def ble_worker(name, request_queue, result_queue, reply_callback, done_callback):
    
    def on_data(characteristic,data):
        #print(f'Received: {data}')
        if hubType == 'SPIKEPrime':
            if data[-1] != 0x02:  # for simplicity, this example does not implement buffering
                print(f"Received incomplete message:\n ")
                return None
        reply = unpack(data)
        if reply_callback: reply_callback(reply)

    async def worker_loop():
        myble = SimpleBLE(request_queue)
        running = True
        while running:
            #print('worker waiting')
            if request_queue.empty():
                await asyncio.sleep(1)
                continue
            req = request_queue.get()
            print(req)
            try:
                if req['topic'] == 'scan':
                    timeout = req.get('msg', 5)
                    devices = await myble.scan_devices(timeout) 
                    result_queue.put(devices)
                    
                elif req['topic'] == 'connect':
                    await myble.connect(req['msg'], on_data)
                    result_queue.put('check')
                    
                elif req['topic'] == 'send':
                    await myble.send(req['msg'])
                    result_queue.put('check')
                    
                elif req['topic'] == 'done':
                    result_queue.put('done')
                    running = False
                print('.',end='')
                
            except Exception as e:
                print('error', e)
                break
        
        done_callback(f"Thread {name} completed")
        myble.on_disconnect(None)
        result_queue.put('done')
        
    print(f"Thread {name}: Starting...")
    asyncio.run(worker_loop())
    print(f"Thread {name}: Finished.")

def main_callback(message):
    print(f"Callback received: {message}\n")
    
def ask(topic, message = None):
    payload = {}
    payload['topic'] = topic
    payload['msg'] = message
    ask_queue.put(payload)
    
def wait_for(topic):
    return reply_queue.get()

ask_queue = queue.Queue()
reply_queue = queue.Queue()

class Hub:
    def __init__(self):
        self.connected = False
        self.ble_thread = threading.Thread(target=ble_worker, args=("BLE", ask_queue, reply_queue, self.reply_callback, self.done_callback))
        self.ble_thread.start()
        self.reply = None

    def device_message(self, data, verbose = False):
        messages = {}
        while data:
            ID = data[0]
            if verbose: print([i for i in data])
            if ID in DEVICE_MESSAGE_MAP:
                name, fmt, keys = DEVICE_MESSAGE_MAP[ID]
                if verbose: print(name, fmt, keys)
                size = struct.calcsize(fmt)
                if size > len(data):
                    if verbose: print('Remaining characters ',data)
                    break
                content = struct.unpack(fmt, data[:size])[1:]  #get rid of id)
                if keys:
                    messages[name] = {k:v for k,v in zip(keys,content)}
                else:
                    messages[name] = content[0] if size == 2 else content
                data = data[size:]
            else:
                print(f"Unknown message: {id}")
                break
        return messages

    def info_response(self, data):
        messages = {}
        for LINE in INFO_MESSAGE:
            name, fmt, keys = LINE
            size = struct.calcsize(fmt)
            content = struct.unpack(fmt, data[:size])
            if keys:
                messages[name] = {k:v for k,v in zip(keys,content)}
            else:
                messages[name] = content[0] if size == 2 else content
            data = data[size:]
        return messages
    
    def reply_callback(self, reply):
        #print(f'\n Reply Callback {reply}')
        try:
            ID = reply[0]

            if ID == 1:
                data = bytes(reply[1:])
                #print(data)
                self.info = self.info_response(data)
                print(self.info)

            elif ID == 60:
                if not self.info:
                    return
                length = struct.unpack('<H',reply[1:3])[0]
                data = bytes(reply[3:])
                if length > len(data):
                    print(f'error - {length} > {len(data)}')
                    return
                self.reply = self.device_message(data, False)
                
            else:
                self.reply = reply
            
        except Exception as e:
            print('Hub error: ',e)
            
    def done_callback(self, message):
        print(f"Done Callback received: {message}\n")

    def scan(self, timeout = 2):
        ask('scan', timeout)
        return wait_for('scan')
    
    def connect(self, device, feed = 1000):
        ask('connect', device)
        reply = wait_for('connect')
        self.connected = True
        
        def build_package(fmt, ID, val = None):
            payload = [ID]
            if val:
                payload.extend(val['values'].values())
            message = pack(struct.pack(fmt, *payload))
            return message

        self.info = None
        fmt, ID, val = commands.get('info')
        ask('send',build_package(fmt, ID))
        reply = wait_for('send')
            
        fmt, ID, val = commands.get('feed')
        val['values']['updateTime'] = feed
        ask('send',build_package(fmt, ID, val))
        reply = wait_for('send')
        return
    
    def json(self, element = None):
        if not self.reply:
            return None
        if not element:
            return self.reply
        path = element.split('.')
        value = self.reply
        for p in path:
            value = value.get(p,{})
        return value

    def search(self, timeout = 5):
        device_list = self.scan(timeout) 
        print(device_list)
        # Find devices
        my_device = next((d for d in device_list if self.search_name in d.name), None)
        return my_device

    def close(self):
        ask('done')
        wait_for('done')
        self.ble_thread.join() 
        
class Joystick(Hub):
    def __init__(self):
        super().__init__()
        self.search_name = 'Controller'

class Spike(Hub):
    def __init__(self):
        super().__init__()
        self.search_name = 'spike'
try:
    s = Spike()
    my_device = s.search(2)
    if my_device:
        s.connect(my_device, feed = 1000)
        while s.connected:
            print(s.json('Motor.position'))
            time.sleep(2)

except KeyboardInterrupt:
    print("Interrupted by user.")

finally:
    s.close()
    print("Main thread: ble_thread completed.")



