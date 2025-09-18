import queue
import threading
import asyncio
from . import SimpleBLE

class Worker:
    def __init__(self):
        self.ask_queue = queue.Queue()
        self.reply_queue = queue.Queue()
        
    def start_thread(self):
        self.ble_thread = threading.Thread(target=self.ble_worker, args=(self.ask_queue, self.reply_queue))
        self.ble_thread.daemon = True  # Make thread daemon so it doesn't prevent exit
        self.ble_thread.start()

    def close_thread(self):
        if self.ble_thread.is_alive():
            print("Waiting for BLE thread to finish...")
        self.ble_thread.join(timeout=3)
        if self.ble_thread.is_alive():
            print("BLE thread did not finish in time")
        else:
            print("BLE thread completed.")

    def ble_worker(self, request_queue, result_queue):
    
        def parse(req, d1 = None, d2 = None, d3 = None, d4 = None):
            return req.get('msg', d1), req.get('msg2', d2), req.get('msg3', d3), req.get('msg4', d4)
    
        async def worker_loop():
            def ble_callback():
                result_queue.put('done')    
                running = False
                print('shutting down')
                
            myble = SimpleBLE.SimpleBLE(ble_callback)
            running = True
            while running:
                if request_queue.empty():
                    await asyncio.sleep(0.5)   
                    continue
                req = request_queue.get()
                
                try:
                    if req['topic'] == 'scan':
                        timeout, callback, name,_ = parse(req, 5)
                        devices = await myble.scan_devices(timeout, name)
                        if callback: callback(devices)
                        
                    elif req['topic'] == 'connect':
                        device, device_callback, connect_callback, disconnect_callback = parse(req)
                        success = await myble.connect(device, device_callback, disconnect_callback)
                        if connect_callback: connect_callback(success)
                        
                    elif req['topic'] == 'send':
                        device, message,_,_ = parse(req)
                        await myble.send(device, message)
                        
                    elif req['topic'] == 'close':
                        device, _,_,_ = parse(req)
                        myble.remote_disconnect(device)
                        
                    elif req['topic'] == 'close_all':
                        myble.close_everything()
                    
                except Exception as e:
                    print('error', e)
                    break

            print("Thread completed")
            myble.on_disconnect(None)

        print("Thread starting...")
        asyncio.run(worker_loop())
        print("Thread finished.")
