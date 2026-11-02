param([string]$ResultPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type 'using System; using System.Runtime.InteropServices; public class FixtureDpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int mode); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
[void][FixtureDpi]::SetProcessDPIAware()
$form=[Windows.Forms.Form]::new()
$form.Text='Faber isolated native fixture'
$form.Size=[Drawing.Size]::new(480,200)
$form.StartPosition='CenterScreen'
$form.TopMost=$true
$box=[Windows.Forms.TextBox]::new()
$box.Location=[Drawing.Point]::new(20,20)
$box.Size=[Drawing.Size]::new(420,30)
$button=[Windows.Forms.Button]::new()
$button.Text='Fixture button'
$button.Location=[Drawing.Point]::new(20,75)
$button.Size=[Drawing.Size]::new(160,35)
$script:clicked=$false
function Save-Fixture {
 $point=$button.PointToScreen([Drawing.Point]::new(30,15))
 @{handle=$form.Handle.ToInt64().ToString();text=$box.Text;clicked=$script:clicked;x=$point.X;y=$point.Y;pid=$PID} | ConvertTo-Json -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}
$box.Add_TextChanged({Save-Fixture})
$button.Add_Click({$script:clicked=$true;Save-Fixture})
$form.Controls.Add($box)
$form.Controls.Add($button)
$form.Add_Shown({[void][FixtureDpi]::ShowWindow($form.Handle,5);[void][FixtureDpi]::SetForegroundWindow($form.Handle);$form.Activate();$box.Focus();Save-Fixture})
$timer=[Windows.Forms.Timer]::new()
$timer.Interval=30000
$timer.Add_Tick({$form.Close()})
$timer.Start()
try {[Windows.Forms.Application]::Run($form)}finally{$timer.Dispose();$form.Dispose()}
