FROM node:22-alpine

WORKDIR /workspace

ENV TZ=Asia/Shanghai
RUN apk add --no-cache bash git openssh-client ripgrep tzdata
RUN npm install -g @openai/codex @lark-project/meegle

CMD ["sleep", "infinity"]
