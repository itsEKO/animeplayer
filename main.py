import sys
import json
import subprocess
import os
import time
import socket
from pathlib import Path

# --- Global RC Configuration ---
RC_HOST = '127.0.0.1'
RC_PORT = 44444 
# -------------------------------

# Global VLC process and status
vlc_process = None
current_file = None

def send_rc_command(command):
    """Sends a command to the running VLC RC interface."""
    try:
        # Give VLC a moment to process the previous command/event
        time.sleep(0.05) 
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.connect((RC_HOST, RC_PORT))
            # Send the command followed by a newline
            s.sendall(f"{command}\n".encode('utf-8'))
            return "OK"
    except ConnectionRefusedError:
        # This is a common error if VLC hasn't fully started or was closed
        print(f"ERROR: Could not connect to VLC RC interface at {RC_HOST}:{RC_PORT}. VLC may be closed.", file=sys.stderr)
        return "ERROR: RC not connected"
    except Exception as e:
        print(f"ERROR: RC communication failed: {e}", file=sys.stderr)
        return f"ERROR: {e}"

def start_vlc_rc(file_path):
    global vlc_process, current_file
    
    # 1. Terminate existing process if any
    if vlc_process:
        # Send stop command to VLC before terminating the Python subprocess
        send_rc_command('stop')
        vlc_process.terminate()
        vlc_process.wait(timeout=2)
        vlc_process = None
        time.sleep(0.5)
        
    current_file = file_path
    
    # 2. Launch VLC with RC interface
    try:
        # CRITICAL FIX: Ensure VLC is launched with the required RC flags
        vlc_process = subprocess.Popen([
            'vlc', 
            '--intf=rc',            # Enable RC interface
            f'--rc-host={RC_HOST}:{RC_PORT}', # Set RC host/port
            '--rc-quiet',           # Don't show RC output in console
            '--fullscreen',         # Launch in fullscreen mode
            file_path               # The file to open
        ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        
        # 3. Wait for the RC server to start
        time.sleep(3) 
        
        # Check if the process died immediately
        if vlc_process.poll() is not None:
             raise Exception("VLC process died immediately. Check if 'vlc' command is in your system PATH or use its absolute path.")
             
        print(json.dumps({
            "status": "playing",
            "message": "VLC launched externally with RC interface."
        }), flush=True)

    except FileNotFoundError:
        error_msg = "VLC executable not found. Since 'vlc' is in PATH, try using the absolute path (e.g., 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe') instead of 'vlc'."
        print(f"ERROR: {error_msg}", file=sys.stderr)
        print(json.dumps({"error": error_msg}), flush=True)
    except Exception as e:
        if vlc_process:
            vlc_process.terminate()
            vlc_process = None
        error_msg = f"Failed to start external VLC process: {e}"
        print(f"ERROR: {error_msg}", file=sys.stderr)
        print(json.dumps({"error": error_msg}), flush=True)

def process_command(command_data):
    global vlc_process
    command = command_data.get('command')
    
    if command == 'load':
        file_path = command_data.get('file_path')
        if not file_path:
            print(json.dumps({"error": "Missing file path"}), flush=True)
            return
        
        path_obj = Path(file_path)
        start_vlc_rc(file_path)
            
    elif command == 'play_pause':
        # RC command for pause is simply 'pause' (toggles play/pause)
        response = send_rc_command('pause')
        print(json.dumps({"status": "toggled", "rc_response": response}), flush=True)

    elif command == 'stop':
        # RC command for stop is 'stop'
        response = send_rc_command('stop')
        if vlc_process:
            vlc_process.terminate()
            vlc_process = None
        print(json.dumps({"status": "stopped", "rc_response": response}), flush=True)
        
    elif command == 'set_subtitle':
        # RC command for subtitle track change: 'sub_track <id>'
        track_id = command_data.get('track_id')
        response = send_rc_command(f'sub_track {track_id}')
        print(json.dumps({"status": "subtitle_set", "id": track_id, "rc_response": response}), flush=True)

    elif command == 'set_audio':
        # RC command for audio track change: 'audio_track <id>'
        track_id = command_data.get('track_id')
        response = send_rc_command(f'audio_track {track_id}')
        print(json.dumps({"status": "audio_set", "id": track_id, "rc_response": response}), flush=True)

    else:
        print(json.dumps({"error": "Unknown command"}), flush=True)

# Main loop to read from stdin
if __name__ == "__main__":
    print("External VLC RC control initialized successfully", file=sys.stderr)
    for line in sys.stdin:
        try:
            command_data = json.loads(line.strip())
            process_command(command_data)
        except json.JSONDecodeError as e:
            print(f"Error decoding JSON: {e}", file=sys.stderr)
        except Exception as e:
            print(f"Unhandled error in main loop: {e}", file=sys.stderr)