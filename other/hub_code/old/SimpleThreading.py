import threading
import queue
import time

def worker_with_callback(name, result_queue, callback_function):
    print(f"Thread {name}: Starting...")
    for i in range(10):
        time.sleep(1)
        result = f"Data from {name} - {i}"
        result_queue.put(result) # Put result into queue
        callback_function(f"Thread {name} completed with result: {result}")
    print(f"Thread {name}: Finished.")
    result_queue.put(None)

def main_callback(message):
    print(f"Callback received: {message}\n")


data_queue = queue.Queue()

thread2 = threading.Thread(target=worker_with_callback, args=("Worker 2", data_queue, main_callback))
thread2.start()

# Get result from the queue in the main thread
while thread2.is_alive():
    received_data = data_queue.get()
    print(f"Main thread received: {received_data}")

thread2.join()   #waitss for thread 2 to complete
print("Main thread: Thread 2 completed.")
