from . import SpikePrime as SPdefinitions
from . import TechElement_EP2 as TE2definitions
from . import TechElement as TEdefinitions

from hub_code.SimpleWorker import *
from hub_code.Hub import *

myWorker = Worker()
CW, CCW, LONG, SHORT = 0, 1, 2, 3

def Background_thread_start():
    myWorker.start_thread()
    
def Background_thread_end():
    myWorker.close_thread()

class Joystick(Hub):
    def __init__(self):
        super().__init__(myWorker)
        self.search_name = 'Controller'
        self.hubType = TEdefinitions
        self.default_key = 'Joystick.rightAngle'

class Color(Hub):
    def __init__(self):
        super().__init__(myWorker)
        self.search_name = 'Color Sensor'
        self.hubType = TEdefinitions
        self.default_key = 'Color.value'

class Single_Motor(Hub):
    def __init__(self):
        super().__init__(myWorker)
        self.search_name = 'Single Motor'
        self.hubType = TEdefinitions
        self.default_key = 'Motor_1.position'
        
    def motor_speed(self, port, speed = 100):
        self.send('motor_speed', port = port, speed = speed & 0xFF)
        
    def motor_run(self, port, direction = CW):
        self.send('motor_run', port = port, direction = direction & 0xFF)
        
    def motor_stop(self, port):
        self.send('motor_stop', port = port)
        

class Double_Motor(Hub):
    def __init__(self):
        super().__init__(myWorker)
        self.search_name = 'Double Motor'
        self.hubType = TEdefinitions
        self.default_key = 'Motor_1.position'

class Spike(Hub):
    def __init__(self,name = 'spike'):
        super().__init__(myWorker)
        self.search_name = name
        self.hubType = SPdefinitions
        self.default_key = 'Motor_A.position'

'''
note - if you want to attach a callback to every time data comes through,
    
def fred(reply):
    print(reply)

self.data_callback = fred
'''