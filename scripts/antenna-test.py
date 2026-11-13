#!/usr/bin/env python3
"""Live readout from the USB receiver on a Mac, for finding a good spot for the antenna.

Needs: brew install librtlsdr dump1090-fa
Run:   scripts/antenna-test.py      (Ctrl+C to stop)

Shows, once a second, how many aircraft messages arrived, how many aircraft are in view and
the strongest signal. More messages per second means a better spot.
"""
import json, os, shutil, subprocess, sys, tempfile, time

if not shutil.which('dump1090'):
    sys.exit('dump1090 is not installed. Run: brew install librtlsdr dump1090-fa')

folder = tempfile.mkdtemp(prefix='antenna-test-')
decoder = subprocess.Popen(
    ['dump1090', '--device-type', 'rtlsdr', '--quiet', '--write-json', folder, '--write-json-every', '1'],
    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)

print('Listening. Move the antenna and watch the numbers. Ctrl+C to stop.\n')
print(f'{"time":8}  {"msgs/sec":>8}  {"aircraft":>8}  {"strongest":>9}  ')
last, best = None, 0
try:
    while True:
        time.sleep(1)
        if decoder.poll() is not None:
            sys.exit('The receiver stopped. Is it plugged in?\n' + decoder.stderr.read().strip())
        try:
            data = json.load(open(os.path.join(folder, 'aircraft.json')))
        except (OSError, ValueError):
            continue
        total = data['messages']
        rate = 0 if last is None else total - last
        last = total
        best = max(best, rate)
        seen = [a for a in data['aircraft'] if a.get('seen', 99) < 15]
        signal = max((a['rssi'] for a in seen if 'rssi' in a), default=None)
        flights = ' '.join(sorted(a['flight'].strip() for a in seen if a.get('flight', '').strip()))
        strength = f'{signal:.0f} dB' if signal is not None else '-'
        bar = '#' * min(rate, 40)
        print(f'{time.strftime("%H:%M:%S")}  {rate:8}  {len(seen):8}  {strength:>9}  {bar} {flights}')
except KeyboardInterrupt:
    print(f'\nBest rate seen: {best} messages a second.')
finally:
    decoder.terminate()
    shutil.rmtree(folder, ignore_errors=True)
