# Mersennet Trade liquidity bots (market-maker + taker).
# Pure Node 20 + global fetch — no dependencies to install.
FROM node:20-alpine
WORKDIR /app
COPY . .
# Default to the market maker; the taker service overrides the command.
CMD ["node", "index.js"]
