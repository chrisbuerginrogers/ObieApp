from SimpleBLE import *
#from SpikePrime import *
from TechElement_EP2 import *
import struct

myble = SimpleBLE()

async def main():

    def device_message(data, verbose = False):
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

    def info_response(data):
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


    async def send(fmt, ID, val = None):
        payload = [ID]
        if val:
            payload.extend(val['values'].values())
        message = pack(struct.pack(fmt, *payload))
        #packet_size = info['MaxSize']['packet'] if info else len(message) - issue here with TechElements
        packet_size = len(message)  # send the frame in packets of packet_size
        for i in range(0, len(message), packet_size):
            packet = message[i : i + packet_size]
            print(f"Sending: {packet}")
            await myble.send(packet)
        
    def my_callback(characteristic,data):
        nonlocal info, sensors
        if hubType == 'SPIKEPrime':
            if data[-1] != 0x02:  # for simplicity, this example does not implement buffering
                print(f"Received incomplete message:\n {un_xor}")
                return
        reply = unpack(data)
        #print(f'Received: {reply}')
        ID = reply[0]

        if ID == 1:
            data = bytes(reply[1:])
            info = info_response(data)
            print(info)
            
        if ID == 60:
            if not info:
                return
            length = struct.unpack('<H',reply[1:3])[0]
            data = bytes(reply[3:])
            if length > len(data):
                print(f'error - {length} > {len(data)}')
                return
            sensors = device_message(data, False)
            print(sensors)
            #print(sensors['Motor']['angle'])
            #print(sensors['Joystick']['leftStep'])

    try:
        info = None
        sensors = None
        
        # Connect up over BLE
        if not await myble.scan():
            return
        await myble.connect(my_callback)
        
        # Send request for info and then feed rate (in msec)
        fmt, ID, val = commands.get('info')
        await send(fmt, ID)
        while not info:  # waits for the info_response to arrive and get parsed
            print('waiting')
            await asyncio.sleep(1)
            
        fmt, ID, val = commands.get('feed')
        val['values']['updateTime'] = 20
        await send(fmt, ID, val)
        
        #  Do anything you want here

        await myble.stop_event.wait()  # wait for the user to stop the script or disconnect the hub

    except KeyboardInterrupt:
        print("Interrupted by user.")

    finally:
        pass #await myble.on_disconnect(myble.client)
    
if __name__ == "__main__":
    asyncio.run(main())

 