param([string]$Payload)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload)) | ConvertFrom-Json
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class HarnessNative {
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd,int cmd);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr handle);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle,out Rect rect);
 public struct Rect { public int Left,Top,Right,Bottom; }
 public delegate bool EnumCallback(IntPtr handle,IntPtr parameter);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback,IntPtr parameter);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle,StringBuilder text,int length);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle,out uint pid);
 public static List<Dictionary<string,object>> Windows() {
  var windows=new List<Dictionary<string,object>>();
  EnumWindows((handle,unused)=> { if(!IsWindowVisible(handle))return true; var text=new StringBuilder(1024); GetWindowText(handle,text,text.Capacity); if(text.Length==0)return true; uint pid; GetWindowThreadProcessId(handle,out pid); string name="";try{name=System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;}catch{}
   windows.Add(new Dictionary<string,object>{{"pid",pid},{"handle",handle.ToInt64().ToString()},{"title",text.ToString()},{"process",name}});return true;
  },IntPtr.Zero);return windows;
 }
 [StructLayout(LayoutKind.Sequential)] public struct KeyboardInput { public ushort vk,scan;public uint flags,time;public UIntPtr extra; }
 [StructLayout(LayoutKind.Sequential)] public struct MouseInput { public int x,y;public uint data,flags,time;public UIntPtr extra; }
 [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KeyboardInput keyboard;[FieldOffset(0)] public MouseInput mouse; }
 [StructLayout(LayoutKind.Sequential)] public struct Input { public uint type;public InputUnion value; }
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,Input[] inputs,int size);
 static Input Key(ushort vk,ushort scan,uint flags) { return new Input{type=1,value=new InputUnion{keyboard=new KeyboardInput{vk=vk,scan=scan,flags=flags}}}; }
 static void Send(List<Input> inputs) { if(SendInput((uint)inputs.Count,inputs.ToArray(),Marshal.SizeOf(typeof(Input)))!=inputs.Count)throw new Exception("Windows rejected keyboard input (target may be elevated)"); }
 public static void Text(string text) { var inputs=new List<Input>();foreach(char c in text){inputs.Add(Key(0,c,4));inputs.Add(Key(0,c,6));}Send(inputs); }
 public static void Chord(string text) {
  var modifiers=new List<ushort>();int i=0;
  while(i<text.Length && "^+%".IndexOf(text[i])>=0) { modifiers.Add(text[i]=='^'?(ushort)17:text[i]=='+'?(ushort)16:(ushort)18);i++; }
  string name=text.Substring(i).Trim('{','}').ToUpperInvariant();ushort key;
  var keys=new Dictionary<string,ushort>{{"ENTER",13},{"TAB",9},{"ESC",27},{"ESCAPE",27},{"BACKSPACE",8},{"BS",8},{"DELETE",46},{"DEL",46},{"LEFT",37},{"UP",38},{"RIGHT",39},{"DOWN",40},{"HOME",36},{"END",35},{"PGUP",33},{"PGDN",34},{"SPACE",32},{"INSERT",45}};
  int number;
  if(name.Length==1 && char.IsLetterOrDigit(name[0]))key=name[0];
  else if(keys.ContainsKey(name))key=keys[name];
  else if(name.StartsWith("F") && int.TryParse(name.Substring(1),out number) && number>=1 && number<=24)key=(ushort)(111+number);
  else throw new Exception("Use one key/chord: ^a, ^s, +{TAB}, {ENTER}, arrows, or F1-F24");
  var inputs=new List<Input>();foreach(ushort modifier in modifiers)inputs.Add(Key(modifier,0,0));
  inputs.Add(Key(key,0,0));inputs.Add(Key(key,0,2));modifiers.Reverse();foreach(ushort modifier in modifiers)inputs.Add(Key(modifier,0,2));Send(inputs);
 }
}
'@
[void][HarnessNative]::SetProcessDPIAware()
$a = $request.args
function Assert-Target {
 param([string]$Handle)
 $target = [IntPtr][long]$Handle
 if (-not [HarnessNative]::IsWindow($target)) { throw 'Target window no longer exists' }
 if ([HarnessNative]::GetForegroundWindow() -ne $target) { throw 'Focus moved away from the target window; input was not sent' }
}
switch ($request.action) {
 'windows' {
  $result = @([HarnessNative]::Windows())
 }
 'screenshot' {
  $bounds = [Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = [Drawing.Bitmap]::new($bounds.Width,$bounds.Height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $stream = [IO.MemoryStream]::new()
  try {
   $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bounds.Size)
   $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
   $result = @{image=('data:image/png;base64,'+[Convert]::ToBase64String($stream.ToArray()));x=$bounds.Left;y=$bounds.Top;width=$bounds.Width;height=$bounds.Height}
  } finally { $stream.Dispose();$graphics.Dispose();$bitmap.Dispose() }
 }
 'focus' {
  $handle = [IntPtr][long]$a.handle
  if (-not [HarnessNative]::IsWindow($handle)) { throw 'Target window no longer exists' }
  [void][HarnessNative]::ShowWindow($handle,9)
  $result = @{focused=[HarnessNative]::SetForegroundWindow($handle)}
 }
 'click' {
  if ($a.handle) { if (-not [HarnessNative]::SetForegroundWindow([IntPtr][long]$a.handle)) { throw 'Could not focus target window' }; Start-Sleep -Milliseconds 100 }
  $bounds = [Windows.Forms.SystemInformation]::VirtualScreen
  if (-not $bounds.Contains([int]$a.x,[int]$a.y)) { throw 'Click is outside the virtual desktop' }
  if ($a.handle) {
   Assert-Target $a.handle
   $rect = [HarnessNative+Rect]::new()
   if (-not [HarnessNative]::GetWindowRect([IntPtr][long]$a.handle,[ref]$rect) -or $a.x -lt $rect.Left -or $a.x -ge $rect.Right -or $a.y -lt $rect.Top -or $a.y -ge $rect.Bottom) { throw 'Click is outside the target window' }
  }
  [void][HarnessNative]::SetCursorPos([int]$a.x,[int]$a.y)
  $down = if ($a.button -eq 'right') { 8 } else { 2 }
  [HarnessNative]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
  [HarnessNative]::mouse_event(($down*2),0,0,0,[UIntPtr]::Zero)
  $result = @{clicked=$true;x=$a.x;y=$a.y}
 }
 'type' {
  if (-not [HarnessNative]::SetForegroundWindow([IntPtr][long]$a.handle)) { throw 'Could not focus target window' }
  Start-Sleep -Milliseconds 100
  Assert-Target $a.handle
  [HarnessNative]::Text([string]$a.text)
  $result = @{typed=$a.text.Length}
 }
 'key' {
  if (-not [HarnessNative]::SetForegroundWindow([IntPtr][long]$a.handle)) { throw 'Could not focus target window' }
  Start-Sleep -Milliseconds 100
  Assert-Target $a.handle
  [HarnessNative]::Chord([string]$a.keys)
  $result = @{sent=$true}
 }
 'launch' {
  $process = Start-Process -FilePath ([string]$a.path) -PassThru
  $result = @{started=$true;pid=$process.Id}
 }
 default { throw 'Unknown desktop action' }
}
ConvertTo-Json -InputObject $result -Compress -Depth 8
