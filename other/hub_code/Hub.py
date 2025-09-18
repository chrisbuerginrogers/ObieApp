import time
import struct

class Hub:
    def __init__(self, myWorker, verbose = False):
        self.connected = False
        self.reply = None
        self.device = None
        self.hubType = None
        self.info = None
        self.myWorker = myWorker
        self.verbose = verbose
        self.device_list = []
        self.data_callback = None

    def device_message(self, data, verbose = False):
        messages = {}
        while data:
            ID = data[0]
            if verbose: print([i for i in data])
            
            if ID in self.hubType.DEVICE_MESSAGE_MAP:
                name, fmt, keys = self.hubType.DEVICE_MESSAGE_MAP[ID]
                if verbose: print(name, fmt, keys)
                size = struct.calcsize(fmt)
                if size > len(data):
                    if verbose: print('Remaining characters ',data)
                    break
                content = struct.unpack(fmt, data[:size])[1:]  #get rid of id)
                if keys:
                    if keys[0] == 'port':
                        name = name + '_' + self.hubType.port_lut[content[0]]
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
        for LINE in self.hubType.INFO_MESSAGE:
            name, fmt, keys = LINE
            size = struct.calcsize(fmt)
            content = struct.unpack(fmt, data[:size])
            if keys:
                messages[name] = {k:v for k,v in zip(keys,content)}
            else:
                messages[name] = content[0] if size == 2 else content
            data = data[size:]
        return messages
    
    def translate(self, reply):
        #print(f'\n Reply Callback {reply}')
        try:
            ID = reply[0]

            if ID == 1:
                data = bytes(reply[1:])
                self.info = self.info_response(data)
                
            elif ID == 41:
                print('Feed rate set')
                
            elif ID == 60:
                if not self.info:
                    return
                length = struct.unpack('<H',reply[1:3])[0]
                data = bytes(reply[3:])
                if length > len(data):
                    print(f'error - {length} > {len(data)}')
                    return
                self.reply = self.device_message(data, self.verbose)
                
            elif ID in [123, 139, 141,]:  # received motor speed command
                data = bytes(reply[1:])
                if data[1] != 0: print('speed setting not set')

            else:
                self.reply = reply
                print('Unknown: ',self.reply)
            
        except Exception as e:
            print('Hub error: ',e)
            
    def ask(self, topic, message = None, message2 = None, message3 = None, message4 = None):
        payload = {}
        payload['topic'] = topic
        payload['msg'] = message
        payload['msg2'] = message2
        payload['msg3'] = message3
        payload['msg4'] = message4
        self.myWorker.ask_queue.put(payload)
        
    def scan_callback(self, devices):
        #print(f'Devices found: {devices}')
        self.devices = devices
        self.scanning = False

    def device_callback(self, characteristic,data):
        #print(f'device_callback {data}')
        if self.hubType.hubType == 'SPIKEPrime':
            if data[-1] != 0x02:  # for simplicity, this example does not implement buffering
                print(f"Received incomplete message:\n ")
                return None
        reply = self.hubType.unpack(data)
        self.translate(reply)
        if self.data_callback: self.data_callback(self.reply)
        
    def connect_callback(self, success):
        if success:
            self.connected = True
        else:
            print('Could not connect')
    
    def disconnect_callback(self):
        self.connected = False
        print('Disconnected')
    
    def scan(self, timeout = 2):
        try:
            self.scanning = True
            self.ask('scan', timeout, self.scan_callback, self.search_name)
            while self.scanning:
                time.sleep(0.1)
            return self.devices
        except Exception as e:
            print('SH_scan error: ',e)
    
    def build_package(self, fmt, ID, val = None):
        payload = [ID]
        if val:
            payload.extend(val['values'].values())
        message = self.hubType.pack(struct.pack(fmt, *payload))
        return message
    
    def connect(self, device, feed = 1000):
        try:
            self.device = device
            self.connected = False
            self.ask('connect', device, self.device_callback, self.connect_callback, self.disconnect_callback)
            while not self.connected:
                time.sleep(0.1)
                
            self.info = None
            fmt, ID, _ = self.hubType.commands.get('info')
            self.ask('send', device, self.build_package(fmt, ID))
            while not self.info:
                time.sleep(0.1)
            print(self.info)
                
            fmt, ID, val = self.hubType.commands.get('feed')
            val['values']['updateTime'] = feed
            self.ask('send', device, self.build_package(fmt, ID, val))
        except Exception as e:
            print('SimpleHub error: ',e)
            
    def send(self, command, **kwargs):
        fmt, ID, val = self.hubType.commands.get(command)
        for k in kwargs:
            val['values'][k] = kwargs[k]
        #print(val)
        #print(self.build_package(fmt, ID, val))
        self.ask('send', self.device, self.build_package(fmt, ID, val))
    
    def json(self, element = None):
        if not self.reply:
            return None
        if not element:
            element = self.default_key
        path = element.split('.')
        value = self.reply
        for p in path:
            value = value.get(p, {})
        return value if value else None

    def search(self, timeout = 5):
        #first check if already scanned
        my_device = next((d for d in self.device_list if self.search_name in d.name), None)
        if my_device: return my_device
        self.device_list = self.scan(timeout) 
        # Find devices
        my_device = next((d for d in self.device_list if self.search_name in d.name), None)
        if not my_device: print(f'could not find {self.search_name}')
        return my_device

    def close(self):
        self.ask('close', self.device)
        
    def close_all(self):
        self.ask('close_all')
        