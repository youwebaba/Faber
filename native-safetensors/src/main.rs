use anyhow::{Context, Result, bail, ensure};
use mistralrs::{CalledFunction, IsqType, LayerTopology, Model, ModelDType, RequestBuilder, Response, StopTokens, TextMessageRole, TextModelBuilder, TokenSource, Tool, ToolCallResponse, ToolCallType, ToolChoice, Topology};
use std::{collections::BTreeMap,io::Read,path::Path};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const LIMIT: usize = 16 * 1024 * 1024;

#[derive(Deserialize,serde::Serialize,Clone,Copy)]
#[serde(rename_all="snake_case")]
enum QuantizationMode { None, Q4_0, Q5_0, Q8_0, #[serde(rename="mixed_q4_q8")] MixedQ4Q8 }
#[derive(Deserialize,serde::Serialize)]
#[serde(deny_unknown_fields)]
struct LoadProfile { mode: QuantizationMode }

fn bounded_json(path:&Path)->Result<Value>{
    let metadata=std::fs::symlink_metadata(path)?;ensure!(metadata.is_file()&&!metadata.file_type().is_symlink()&&metadata.len()<=LIMIT as u64,"Invalid native metadata file");
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn tensor_elements(shape:&Value)->Result<u64>{
    let values=shape.as_array().context("Missing native tensor shape")?;ensure!(values.len()<=16,"Invalid native shape rank");
    let mut count=1u64;for value in values{count=count.checked_mul(value.as_u64().context("Invalid native shape")?).context("Native shape overflow")?;}ensure!(count<=9007199254740991,"Native shape exceeds safe transport size");Ok(count)
}
fn tensor_header(path:&Path)->Result<Value>{
    let mut file=std::fs::File::open(path)?;let mut prefix=[0u8;8];file.read_exact(&mut prefix)?;let length=u64::from_le_bytes(prefix);
    ensure!(length<=LIMIT as u64&&length+8<=file.metadata()?.len(),"Invalid native tensor metadata length");let mut bytes=vec![0u8;length as usize];file.read_exact(&mut bytes)?;Ok(serde_json::from_slice(&bytes)?)
}
fn precision_report(model_path:&Path,verification:&Path,mode:QuantizationMode)->Result<Value>{
    if matches!(mode,QuantizationMode::None){
        let mut parameters=0u64;let mut tensors=0u64;
        for entry in std::fs::read_dir(model_path)?{let entry=entry?;if entry.file_name().to_string_lossy().ends_with(".safetensors"){
            for(name,tensor)in tensor_header(&entry.path())?.as_object().context("Invalid tensor header")?{if name!="__metadata__"{parameters=parameters.checked_add(tensor_elements(&tensor["shape"])?).context("Parameter count overflow")?;tensors+=1;}}
        }}
        ensure!(parameters>0&&parameters<=9007199254740991/4,"Invalid floating weight count");
        return Ok(json!({"verified":true,"method":"native-float32-loader","parameters":parameters,"formats":{"f32":tensors},"effectiveBitsPerParameter":32.0,"logicalWeightBytes":parameters*4,"fallbackCount":0}));
    }
    let report=bounded_json(&verification.join("uqff_report.json"))?;let output=&report["outputs"][0];
    let details=output["layer_details"].as_array().context("Missing native precision details")?;ensure!(!details.is_empty(),"No native quantized layers were verified");
    let mut parameters=0u64;let mut parameters_by_format=BTreeMap::<String,u64>::new();
    for layer in details{let count=tensor_elements(&layer["shape"])?;parameters=parameters.checked_add(count).context("Parameter count overflow")?;let format=layer["stored"].as_str().context("Missing actual native format")?;ensure!(format.len()<40,"Invalid format label");*parameters_by_format.entry(format.to_owned()).or_default()+=count;}
    let residual=verification.join("residual.safetensors");if residual.is_file(){for(name,tensor)in tensor_header(&residual)?.as_object().context("Invalid residual tensor header")?{if name!="__metadata__"{let count=tensor_elements(&tensor["shape"])?;parameters=parameters.checked_add(count).context("Parameter count overflow")?;let dtype=tensor["dtype"].as_str().context("Missing residual dtype")?.to_lowercase();*parameters_by_format.entry(dtype).or_default()+=count;}}}
    let mut packed_bytes=0u64;
    for entry in std::fs::read_dir(verification)?{let entry=entry?;let metadata=entry.file_type()?;ensure!(metadata.is_file()&&!metadata.is_symlink(),"Unexpected native verification artifact");let name=entry.file_name();let name=name.to_string_lossy();if name.ends_with(".uqff")||name=="residual.safetensors"{packed_bytes=packed_bytes.checked_add(entry.metadata()?.len()).context("Native storage budget overflow")?;}}
    ensure!(parameters>0&&parameters<=9007199254740991&&packed_bytes<=9007199254740991,"Invalid verified weight budget");
    let result=json!({"verified":true,"method":"native-uqff-verification","parameters":parameters,"formats":output["actual_counts"],"parametersByFormat":parameters_by_format,"effectiveBitsPerParameter":packed_bytes as f64*8.0/parameters as f64,"packedBytes":packed_bytes,"fallbackCount":output["fallback_count"],"layers":output["layers"],"verificationRemoved":true});
    let parent=model_path.canonicalize()?;let target=verification.canonicalize()?;
    ensure!(target.parent()==Some(parent.as_path())&&target.file_name()==Some(std::ffi::OsStr::new(".faber-precision")),"Unsafe precision cleanup target");
    std::fs::remove_dir_all(&target)?;Ok(result)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command { kind: String, id: u64, #[serde(default)] body: Option<Body> }
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Body {
    model: String,
    #[serde(default)] messages: Vec<Message>,
    prompt: Option<String>,
    #[serde(default)] stream: bool,
    stream_options: Option<Value>,
    temperature: Option<f64>, top_p: Option<f64>, top_k: Option<usize>, min_p: Option<f64>,
    max_tokens: Option<usize>, max_completion_tokens: Option<usize>,
    frequency_penalty: Option<f32>, presence_penalty: Option<f32>, stop: Option<Value>,
    tools: Option<Vec<Tool>>, tool_choice: Option<ToolChoice>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Message { role: String, #[serde(default)] content: Value, tool_call_id: Option<String>, tool_calls: Option<Vec<Value>> }

fn request(body: Body) -> Result<RequestBuilder> {
    ensure!(body.model == "worker-model", "Wrong native model identity");
    let _transport = (body.stream, body.stream_options);
    let mut result = RequestBuilder::new();
    if let Some(prompt) = body.prompt { ensure!(body.messages.is_empty(), "Choose prompt or messages"); result = result.add_message(TextMessageRole::User, prompt); }
    for message in body.messages {
        let text = match message.content {
            Value::Null => String::new(), Value::String(text) => text,
            Value::Array(parts) => {
                let mut text = String::new();
                for part in parts { ensure!(part["type"] == "text", "Only text input is supported"); text.push_str(part["text"].as_str().context("Invalid text part")?); }
                text
            }
            _ => bail!("Only text input is supported"),
        };
        let role = match message.role.as_str() { "user" => TextMessageRole::User, "assistant" => TextMessageRole::Assistant, "system" => TextMessageRole::System, "tool" => TextMessageRole::Tool, _ => bail!("Unsupported message role") };
        if message.role == "tool" { result = result.add_tool_message(text, message.tool_call_id.context("Missing tool call ID")?); }
        else if let Some(calls) = message.tool_calls {
            ensure!(message.role == "assistant", "Tool calls require an assistant message");
            let calls = calls.into_iter().enumerate().map(|(index, call)| -> Result<_> { ensure!(call["type"] == "function", "Only function tool definitions are supported"); Ok(ToolCallResponse { index, id: call["id"].as_str().context("Missing tool call ID")?.to_owned(), tp: ToolCallType::Function, function: CalledFunction { name: call["function"]["name"].as_str().context("Missing tool name")?.to_owned(), arguments: call["function"]["arguments"].as_str().context("Invalid tool arguments")?.to_owned() } }) }).collect::<Result<Vec<_>>>()?;
            result = result.add_message_with_tool_call(role, text, calls);
        } else { result = result.add_message(role, text); }
    }
    if let Some(value) = body.temperature { ensure!(value.is_finite() && value >= 0., "Invalid temperature"); result = result.set_sampler_temperature(value); }
    if let Some(value) = body.top_p { ensure!(value.is_finite() && (0. ..=1.).contains(&value), "Invalid top_p"); result = result.set_sampler_topp(value); }
    if let Some(value) = body.top_k { result = result.set_sampler_topk(value); }
    if let Some(value) = body.min_p { ensure!(value.is_finite() && (0. ..=1.).contains(&value), "Invalid min_p"); result = result.set_sampler_minp(value); }
    if let Some(value) = body.max_tokens.or(body.max_completion_tokens) { ensure!(value > 0, "Invalid maximum tokens"); result = result.set_sampler_max_len(value); }
    if let Some(value) = body.frequency_penalty { ensure!(value.is_finite(), "Invalid frequency penalty"); result = result.set_sampler_frequency_penalty(value); }
    if let Some(value) = body.presence_penalty { ensure!(value.is_finite(), "Invalid presence penalty"); result = result.set_sampler_presence_penalty(value); }
    if let Some(value) = body.stop { let stops = if let Value::String(value) = value { vec![value] } else { serde_json::from_value::<Vec<String>>(value)? }; result = result.set_sampler_stop_toks(StopTokens::Seqs(stops)); }
    if let Some(tools) = body.tools {
        for tool in &tools { ensure!(serde_json::to_value(tool)?["type"] == "function", "Only Faber function tool definitions are supported"); }
        result = result.set_tools(tools);
    }
    if let Some(choice) = body.tool_choice {
        let value=serde_json::to_value(&choice)?;
        ensure!(value.is_string() || value["type"] == "function", "Hosted native tools are unavailable");
        result = result.set_tool_choice(choice);
    }
    Ok(result)
}

async fn write(value: Value) -> Result<()> {
    let bytes = serde_json::to_vec(&value)?; ensure!(bytes.len() <= LIMIT, "Worker output exceeds frame limit");
    let mut output = tokio::io::stdout(); output.write_u32_le(bytes.len() as u32).await?; output.write_all(&bytes).await?; output.flush().await?; Ok(())
}
async fn generate(model: &Model, command: Command, input: &mut tokio::sync::mpsc::Receiver<Result<Command>>) -> Result<bool> {
    let id = command.id;
    let request = request(command.body.context("Missing request body")?)?;
    let mut stream = model.stream_chat_request(request).await?;
    loop {
        tokio::select! {
            command = input.recv() => {
                match command { None => return Ok(false), Some(Ok(command)) if command.kind == "cancel" && command.id == id => { write(json!({"kind":"done","id":id,"canceled":true})).await?; return Ok(true); }, Some(_) => bail!("Only cancellation is allowed while generating") }
            }
            response = stream.next() => {
                match response {
                    None => break,
                    Some(Response::Chunk(value)) => write(json!({"kind":"chunk","id":id,"value":value})).await?,
                    Some(Response::Done(value)) => write(json!({"kind":"result","id":id,"value":value})).await?,
                    Some(Response::InternalError(error) | Response::ValidationError(error)) => return Err(anyhow::anyhow!(error.to_string())),
                    Some(Response::ModelError(error, _)) => bail!("{error}"),
                    Some(_) => bail!("Unexpected non-text native response"),
                }
            }
        }
    }
    write(json!({"kind":"done","id":id})).await?; Ok(true)
}
#[tokio::main]
async fn main() -> Result<()> {
    let mut args=std::env::args().skip(1);
    let model_path = args.next().context("Supply one validated local model directory")?;
    let profile=args.next().context("Supply a validated native load profile")?;
    ensure!(profile.len()<=1024&&args.next().is_none(),"Invalid native launch profile");
    let profile:LoadProfile=serde_json::from_str(&profile)?;
    ensure!(std::path::Path::new(&model_path).is_absolute() && std::path::Path::new(&model_path).join("config.json").is_file(), "Supply an existing local model package");
    ensure!(std::env::var("HF_HUB_OFFLINE").as_deref() == Ok("1"), "The worker requires offline mode");
    let model_path=std::path::PathBuf::from(model_path);let verification=model_path.join(".faber-precision");ensure!(!verification.exists(),"Native precision folder already exists");
    let mut builder=TextModelBuilder::new(model_path.to_string_lossy()).with_force_cpu().with_dtype(ModelDType::F32).with_token_source(TokenSource::None).with_max_num_seqs(1).without_paged_attn();
    builder=match profile.mode { QuantizationMode::None=>builder,QuantizationMode::Q4_0=>builder.with_isq(IsqType::Q4_0),QuantizationMode::Q5_0=>builder.with_isq(IsqType::Q5_0),QuantizationMode::Q8_0=>builder.with_isq(IsqType::Q8_0),QuantizationMode::MixedQ4Q8=>{
        let config=bounded_json(&model_path.join("config.json"))?;let layers=config["num_hidden_layers"].as_u64().context("Mixed precision requires decoder layer metadata")?;ensure!((2..=8192).contains(&layers),"Unsupported mixed-precision layer count");
        builder.with_isq(IsqType::Q4_0).with_topology(Topology::with_capacity(layers as usize).with_range(0..layers as usize/2,LayerTopology{isq:Some(IsqType::Q4_0),device:None}).with_range(layers as usize/2..layers as usize,LayerTopology{isq:Some(IsqType::Q8_0),device:None}))
    }};
    if !matches!(profile.mode,QuantizationMode::None){builder=builder.write_uqff(verification.join("weights.uqff"));}
    let model=builder.build().await?;
    let precision=precision_report(&model_path,&verification,profile.mode)?;
    write(json!({"kind":"ready","protocol":3,"model":"worker-model","backend":"cpu","quantization":profile,"precision":precision})).await?;
    let (sender, mut receiver) = tokio::sync::mpsc::channel(1);
    tokio::spawn(async move {
        let mut input = tokio::io::stdin();
        loop {
            let result = async {
                let length = input.read_u32_le().await? as usize; ensure!(length > 0 && length <= LIMIT, "Worker request exceeds frame limit");
                let mut bytes = vec![0; length]; input.read_exact(&mut bytes).await?; Ok::<Command, anyhow::Error>(serde_json::from_slice(&bytes)?)
            }.await;
            let failed = result.is_err(); if sender.send(result).await.is_err() || failed { break; }
        }
    });
    while let Some(command) = receiver.recv().await {
        let command = command?;
        // Completion and abort can cross in the pipe; a late cancellation is harmless.
        if command.kind == "cancel" { continue; }
        let id = command.id; ensure!(command.kind == "generate", "Unsupported worker operation");
        match generate(&model, command, &mut receiver).await { Ok(false) => break, Ok(true) => {}, Err(error) => write(json!({"kind":"error","id":id,"message":error.to_string()})).await? }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn probe_native_ten_bit_candidate() {
        let result=mistralrs::parse_isq_value("q10_0",None);assert!(result.is_err(),"A new upstream codec requires separate qualification");
        println!("10-bit candidate q10_0 unsupported: {}",result.err().unwrap());
    }
    #[test]
    fn untrusted_request_cannot_enable_host_tools_or_media() {
        assert!(serde_json::from_value::<LoadProfile>(json!({"mode":"q4_0","shell":true})).is_err());
        assert!(serde_json::from_value::<LoadProfile>(json!({"mode":"unknown"})).is_err());
        assert!(serde_json::from_value::<Body>(json!({"model":"worker-model","messages":[],"enable_shell":true})).is_err());
        let body: Body = serde_json::from_value(json!({"model":"worker-model","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"http://remote"}}]}]})).unwrap(); assert!(request(body).is_err());
        let body: Body = serde_json::from_value(json!({"model":"worker-model","messages":[{"role":"tool","content":"value"}]})).unwrap(); assert!(request(body).is_err());
        assert!(serde_json::from_value::<Body>(json!({"model":"worker-model","messages":[],"tool_choice":{"type":"web_search"}})).map(|body|request(body).is_err()).unwrap_or(true));
        let body: Body=serde_json::from_value(json!({"model":"worker-model","messages":[{"role":"user","content":"Use a Faber tool"}],"tools":[{"type":"function","function":{"name":"fixture_read","description":"Read a fixture","parameters":{"type":"object","properties":{}}}}],"tool_choice":"auto"})).unwrap();assert!(request(body).is_ok());
    }
}
