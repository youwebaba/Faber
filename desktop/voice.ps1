$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
 Add-Type -AssemblyName System.Speech
 Add-Type -AssemblyName System.Web.Extensions
 Add-Type -ReferencedAssemblies @('System.Speech','System.Web.Extensions') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Web.Script.Serialization;
public class HarnessSpeech {
 static JavaScriptSerializer json = new JavaScriptSerializer();
 static object gate = new object();
 static SpeechRecognitionEngine recognizer;
 static SpeechSynthesizer synthesizer;
 static bool listening;
 static void Emit(object value) { lock(gate) { Console.WriteLine(json.Serialize(value)); Console.Out.Flush(); } }
 public static void Run() {
  var installed = SpeechRecognitionEngine.InstalledRecognizers();
  Emit(new {kind="ready",recognizers=installed.Count});
  string line;
  while((line=Console.ReadLine())!=null) {
   string id=null;
   try {
    var request=json.Deserialize<Dictionary<string,object>>(line);
    id=(string)request["id"]; var action=(string)request["action"];
    if(action=="start") {
     if(installed.Count==0) throw new Exception("No Windows speech recognizer is installed. Install a Windows speech language pack.");
     if(recognizer==null) {
      recognizer=new SpeechRecognitionEngine(installed[0]);
      recognizer.LoadGrammar(new DictationGrammar());
      recognizer.SpeechRecognized += (s,e)=> { if(listening && e.Result.Confidence>=0.45) Emit(new {kind="transcript",text=e.Result.Text,confidence=e.Result.Confidence}); };
      recognizer.RecognizeCompleted += (s,e)=> { if(e.Error!=null) Emit(new {kind="error",error=e.Error.Message}); };
     }
     if(!listening) { recognizer.SetInputToDefaultAudioDevice(); listening=true; recognizer.RecognizeAsync(RecognizeMode.Multiple); }
    } else if(action=="stop") {
     listening=false; if(recognizer!=null) recognizer.RecognizeAsyncCancel();
     if(synthesizer!=null) synthesizer.SpeakAsyncCancelAll();
    } else if(action=="speak") {
     bool resume=listening; listening=false;
     // Stop recognition before TTS so synthesized speech cannot activate another chat.
     if(recognizer!=null) { recognizer.RecognizeAsyncCancel(); System.Threading.Thread.Sleep(200); }
     if(synthesizer==null) { synthesizer=new SpeechSynthesizer(); synthesizer.SetOutputToDefaultAudioDevice(); }
     synthesizer.Speak((string)request["text"]);
     if(resume) { System.Threading.Thread.Sleep(250); listening=true; recognizer.RecognizeAsync(RecognizeMode.Multiple); }
    } else if(action=="status") {
     Emit(new {kind="response",id=id,ok=true,recognizers=installed.Count,listening=listening}); continue;
    } else throw new Exception("Unknown speech action");
    Emit(new {kind="response",id=id,ok=true,listening=listening});
   } catch(Exception error) { Emit(new {kind="response",id=id,ok=false,error=error.Message}); }
  }
  if(recognizer!=null) recognizer.Dispose(); if(synthesizer!=null) synthesizer.Dispose();
 }
}
'@
 [HarnessSpeech]::Run()
} catch {
 @{kind='error';error=$_.Exception.Message} | ConvertTo-Json -Compress
 exit 1
}
