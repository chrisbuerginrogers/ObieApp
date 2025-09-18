from SimpleHub import Hub
import time
from SimpleBLE3 import BLEManager
import asyncio

ble = BLEManager()

motor = Hub(ble)
#light = Hub(ble)

async def main():
    await ble.scan(2) # can scan on any hub
    device_list = ble.device_list

    # Find devices
    motor_device = next((d for d in device_list if 'Motor' in d.name), None)
    light_device = next((d for d in device_list if 'Color' in d.name), None)


    try:
        motor.connect(motor_device)
        #light.connect(light_device)
        
        #print(light.connected, light.connected)

        while motor.connected:# and motor.connected:
            #motor.speed = light.value
            #motor.run()
            #print(light.reply)
            print(motor.reply)
            time.sleep(2)
            
        #await myble.stop_event.wait()  # wait for the user to stop the script or disconnect the hub

    except KeyboardInterrupt:
        print("Interrupted by user.")

    finally:
        ble.close_all()

asyncio.run(main())
''' Very Simple

hub = Hub()

device_list = hub.ble_scan(2)
if device_list:
    hub.connect(device_list[0])
    while hub.connected:
         time.sleep(0.5)
         
'''

