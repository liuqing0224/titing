FROM node:22-alpine

WORKDIR /workspace

RUN apk add --no-cache bash git openssh-client ripgrep
RUN npm install -g @openai/codex @lark-project/meegle

CMD ["sleep", "infinity"]
