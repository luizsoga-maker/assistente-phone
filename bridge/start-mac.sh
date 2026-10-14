#!/bin/bash
# Instala (na primeira vez), liga a ponte do Claude Code e abre o assistente no Safari.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js não encontrado. Instale com: brew install node"
  exit 1
fi
if [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  echo "Precisa do Node 20 ou mais novo. Atualize com: brew upgrade node"
  exit 1
fi

[ -d node_modules ] || npm install

if [ ! -f .env ]; then
  read -r -s -p "Cole sua chave da API Anthropic (sk-ant-...): " KEY; echo
  printf 'BRIDGE_TOKEN=%s\nANTHROPIC_API_KEY=%s\n' "$(openssl rand -hex 24)" "$KEY" > .env
  chmod 600 .env
  echo "Criado bridge/.env"
fi

if [ ! -f projects.json ]; then
  # Começa liberando só este repositório; edite projects.json para adicionar outros
  printf '{\n  "assistente-phone": "%s"\n}\n' "$(cd .. && pwd)" > projects.json
  echo "Criado bridge/projects.json (edite para liberar outros projetos)"
fi

is_bridge() { curl -s -m 2 "http://localhost:$1/" | grep -q 'name="bridge-token"'; }
port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

PORT=$(grep -E '^PORT=' .env | cut -d= -f2); PORT=${PORT:-8787}
# Porta ocupada por outro programa: procura uma livre e grava no .env
if port_busy "$PORT" && ! is_bridge "$PORT"; then
  echo "A porta $PORT está em uso por outro programa."
  for P in $(seq 8788 8899); do
    if ! port_busy "$P"; then PORT=$P; break; fi
  done
  sed -i '' '/^PORT=/d' .env
  echo "PORT=$PORT" >> .env
  echo "Usando a porta $PORT (gravada em bridge/.env)."
fi

if is_bridge "$PORT"; then
  echo "A ponte já está rodando."
else
  nohup node server.mjs > bridge.log 2>&1 &
  for _ in 1 2 3 4 5 6 7 8 9 10; do is_bridge "$PORT" && break; sleep 1; done
  if ! is_bridge "$PORT"; then
    echo "A ponte não subiu. Veja bridge/bridge.log:"; tail -20 bridge.log; exit 1
  fi
  echo "Ponte rodando (log em bridge/bridge.log). Para parar: pkill -f 'node server.mjs'"
fi
open -a Safari "http://localhost:$PORT/"
