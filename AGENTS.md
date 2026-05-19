we are building a green field service
continuous is an open source business platform
its goal it to unlock the future SMB economy 
powered by human, ai, and robot workforce

the complete strategy is in STRATEGY.md

always be ambitious and bold
always maximize thruput with 6 subagents

always choose simple, clear naming for files, functions, and objects that an intelligent system or human can infer due to context over word salad verbose names

for data models, prefer a small set of clear primitives with type/kind/role/status fields over many near-duplicate entity names

always commit clearly like the best engineers do

we will host infra on digital ocean use doctl

keep a running notes file in implementation.md with decisions you had to make weren't in the strategy or spec, things you had to change, tradeoffs you had to make or anything else I should know

keep a running tasks file in tasks.md with follow up tasks you need me to take for you

keep these files in notes/ folder

use bun over npm/pnpm

use computer use + chrome do not use playwright

use shadcn correctly for all UI components following their example code exactly so we have high quality UI out of the box

have a sense of humor with any sample content or data

for the ai gateway, you can clone cleanup remove braintrust info and rework for our purposes without having to write all of the content https://github.com/braintrustdata/braintrust-proxy

security is very important, always think about security implications and protection against adversarial attacks or malicious actors

you can call Claude CLI for focused second opinions or monitoring; wrap the CLI call in a subagent so the streamed output does not blow the main context window:

```sh
claude -p "your prompt" \
  --output-format stream-json \
  --verbose \
  --include-partial-messages \
  --permission-mode dontAsk \
  --allowedTools "Read,Edit, Write"
```
