# Mersennet Trade liquidity bots (market-maker + taker).
# Node 20 + ethers (for signing txs to the CLOB precompile).
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
# Default to the market maker; the taker service overrides the command.
CMD ["node", "index.js"]
