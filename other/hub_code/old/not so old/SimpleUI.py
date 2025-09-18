import tkinter as tk
from tkinter import ttk
from tkinter import messagebox
from bleak import BleakClient, BleakScanner
from bleak.backends.characteristic import BleakGATTCharacteristic
from bleak.backends.device import BLEDevice
from bleak.backends.scanner import AdvertisementData

import asyncio

SPIKE_SERVICE_UUID = "0000fd02-0000-1000-8000-00805f9b34fb"
SPIKE_WRITE_UUID   = "0000fd02-0001-1000-8000-00805f9b34fb"   # RX - for sending data TO the hub
SPIKE_NOTIFY_UUID  = "0000fd02-0002-1000-8000-00805f9b34fb"   # TX - for receiving data FROM the hub

class Panel:
    def __init__(self, root, btn_callback):
        self.root = root
        self.root.title("Simple Demo")
        self.root.geometry("500x200")
        
        self.running = False
        
        main_frame = ttk.Frame(self.root, padding="20")
        main_frame.grid(row=1, column=0, sticky=(tk.W, tk.E, tk.N, tk.S))

        # Add explanatory text at the top
        info_text = """This demo is a simple user interface to seeing how the variables change"""
        
        info_label = tk.Label(root, text=info_text, justify=tk.LEFT, font=("Arial", 14), fg="gray", wraplength=480, pady=10)
        info_label.grid(row=0, column=0, sticky=tk.W, padx=20, pady=(10, 0))

        # info display
        ttk.Label(main_frame, text="Info Response:", font=("Arial", 12)).grid(row=1, column=0, pady=10)
        self.info_label = ttk.Label(main_frame, text="0", font=("Arial", 14))
        self.info_label.grid(row=1, column=1, pady=10, padx=10)
        self.info_label.config(text="waiting...", foreground="blue")

        # value display
        ttk.Label(main_frame, text="Current Value:", font=("Arial", 12)).grid(row=2, column=0, pady=10)
        self.value_label = ttk.Label(main_frame, text="0", font=("Arial", 16, "bold"), foreground="green")
        self.value_label.grid(row=2, column=1, pady=10, padx=10)
        
        # Create a button
        tk.Button(main_frame, text="Connect", command=btn_callback).grid(row=3, column=0, pady=10)


async def main():
    def check_service_uuid(device: BLEDevice, adv: AdvertisementData) -> bool:
        return SPIKE_SERVICE_UUID.lower() in adv.service_uuids

    matching_devices = []
    def device_found_callback(device: BLEDevice, adv: AdvertisementData):
        if True: #check_service_uuid(device, adv):
            # Avoid duplicates (same device might be detected multiple times)
            if not any(d.address == device.address for d in matching_devices):
                matching_devices.append(device)
                print(f"Found hub: {device.name} ({device.address})")
                listbox.insert(tk.END, device.name)

    scanner = BleakScanner(detection_callback=device_found_callback)

    async def on_button_click():
        print('clicked')
        
        # Create popup
        popup = tk.Toplevel(root)
        popup.title("Select device")
        popup.geometry("300x250")
        popup.transient(root)  # make it on top
        popup.grab_set()       # make it modal (grab all keyboard input)
        
        tk.Label(popup, text="Choose a device:", font=("Arial", 12)).pack(pady=10)
        
        # Create listbox with options
        listbox = tk.Listbox(popup, height=6)
        listbox.pack(pady=10, padx=20, fill=tk.X)
        
        # Add your options
        #devices = ["Server 1 (192.168.1.10)", "Server 2 (192.168.1.20)", 
        #           "Local Server", "Development Server", "Production Server"]
        
        #for device in devices:
        #    listbox.insert(tk.END, device)
        await scanner.start()
        
        # Select first item by default
        listbox.selection_set(0)
        
        def select_action():
            selection = listbox.curselection()
            if selection:
                selected_device = devices[selection[0]]
                print(f"Selected: {selected_device}")
                # Your logic here
                popup.destroy()
        
        async def cancel_action():
            popup.destroy()
            await scanner.stop()
        
        button_frame = tk.Frame(popup)
        button_frame.pack(pady=20)
        tk.Button(button_frame, text="Select", command=select_action).pack(side=tk.LEFT, padx=5)
        #tk.Button(button_frame, text="Cancel", command=cancel_action).pack(side=tk.LEFT, padx=5)


    root = tk.Tk()
    app = Panel(root,on_button_click)
    
    # Handle window closing
    def on_closing():
        app.running = False
        root.destroy()
        # Force exit the Python process
        import sys
        sys.exit(0)
    
    root.protocol("WM_DELETE_WINDOW", on_closing)
    root.mainloop()

if __name__ == "__main__":
    asyncio.run(main())