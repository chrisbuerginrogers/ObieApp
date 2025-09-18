import struct
import asyncio
from TechElement_EP2 import *

class Hub:
    def __init__(self, ble):
        self.ble = ble
        self.device = None
        self.connected = False
        self.callback = self.data_callback
        self.info = None
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
                #print(f"Unknown message: {id}")
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

    def data_callback(self, characteristic,data):
        print(f'Received: {data}')
        if hubType == 'SPIKEPrime':
            if data[-1] != 0x02:  # for simplicity, this example does not implement buffering
                print("Received incomplete message:\n")
                return
        reply = unpack(data)
        #print(f'Received: {reply}')
        ID = reply[0]

        if ID == 1:
            data = bytes(reply[1:])
            self.info = self.info_response(data)
            print(self.info)
            
        if ID == 60:
            if not self.info:
                return
            length = struct.unpack('<H',reply[1:3])[0]
            data = bytes(reply[3:])
            if length > len(data):
                print(f'error - {length} > {len(data)}')
                return
            self.reply = self.device_message(data, False)
        
    async def connect(self, device, feed = 20):
        if not device:
            print(f'failed to find device {device}')
            self.connected = False
            return
        self.device = device
        print('device',self.device)
        
        async def send_package(fmt, ID, val = None):
            payload = [ID]
            if val:
                payload.extend(val['values'].values())
            message = pack(struct.pack(fmt, *payload))
            print(f"Sending: {message}")
            await self.ble.send(self.device, message)

        self.info = None
        await self.ble.ble_connect(self.device, self.callback)        
        print('sadf')
        self.connected = True
        fmt, ID, val = commands.get('info')
        await send_package(fmt, ID)
        while not self.info:  # waits for the info_response to arrive and get parsed
            print('waiting')
            await asyncio.sleep(1)
            
        fmt, ID, val = commands.get('feed')
        val['values']['updateTime'] = feed
        await send_package(fmt, ID, val)

