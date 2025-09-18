import time

from hub_code.SimpleHub import *

Background_thread_start()

try:
    hub = Single_Motor()  # these are defined in SimpleHub - Spike('name'), Single_Motor(), Double_Motor(), Color(), Joystick()
    hub_device = hub.search(timeout = 5)

    if hub_device:
        print('Trying to connect to ',hub_device.name)
        hub.connect(hub_device, feed = 20)  # feed rate in millisec
        while hub.connected:
            print(hub.json('Motor_1.position')) # blank returns the default sensor value
            # print(hub.reply) gives the complete set of data
            time.sleep(1)
            
            hub.motor_speed(1,100)
            hub.motor_run(1, CCW)
            time.sleep(1)
            hub.motor_stop(1)

except KeyboardInterrupt:
    print("Interrupted by user.")

finally:
    hub.close()
        
        
Background_thread_end()



