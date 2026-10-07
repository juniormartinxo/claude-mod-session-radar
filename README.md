# session-radar

Painel ao vivo, aberto com `/radar`, que mostra todas as sessões do Claude Code rodando nesta máquina: status, último prompt, contexto, tokens, cache e os limites de uso da conta (5 horas e semanal).

```
◎ RADAR                  5h ⢷⡾ ⢷⡾ ⢷⡾ ⢷⡾ ⢷⡾  90% [1h56] 18:30
3 sessões                7d ⢷⡾ ⢷⡾ ⢷⡾ ⢷⡾ ⢷⡾  78% [4d 15h] 09/10 10:00

● 1 trabalhando  ◆ 0 aguardando  ○ 2 ociosas

╭──────────────────────────────────────────────────────────────╮
│ ● dsk-24-1f                              trabalhando · 2 min │
│ ~/apps/workspaces/dusky/dsk-24                               │
│ ❯ roda os testes de novo · 3 min                             │
│ ctx ▰▰▰▰▰▰▰▱▱▱▱▱ 58% · faltam 84k de 200k                    │
│ Σ 4,1M tokens gastos · 26k de saída · opus-5-5               │
│ cache 97% · 3,9M lido · 150k escrito  ◷ expira em 57 min (1h)│
│ 404 MB · 1% cpu · aberta há 5h42   amjr · terminal · v2.1.289│
│ ⧉ copiar resume  ⧉ copiar caminho  1: ✉ mensagem              │
╰──────────────────────────────────────────────────────────────╯
```

## Requisitos

- Claude Code com suporte a mods (*function hooks*). Feito e testado na 2.1.289. A API está em *early access* e pode mudar entre versões.
- Linux ou WSL: o mod lê `/proc` para saber se cada sessão está viva. Não funciona no macOS nem no Windows nativo.

## Instalar

Clone o repositório numa pasta qualquer. Os exemplos abaixo usam `~/claude-mods/session-radar`:

```bash
git clone https://github.com/juniormartinxo/claude-mod-session-radar.git ~/claude-mods/session-radar
```

Não há dependências para instalar: o Claude Code carrega o `.tsx` direto.

## Usar

### Só numa sessão: a flag `--plugin-dir`

```bash
claude --plugin-dir ~/claude-mods/session-radar
```

O mod carrega apenas na sessão aberta com a flag. Dentro dela, digite `/radar` para abrir ou fechar o painel.

### Em todas as sessões: a variável `CLAUDE_CODE_PLUGIN_DIRS`

Para o `/radar` estar disponível sempre, sem precisar da flag, inclua a pasta em `CLAUDE_CODE_PLUGIN_DIRS`. Ela aceita várias pastas separadas por `:`, e cada uma é carregada como se fosse um `--plugin-dir`.

O lugar mais simples é o bloco `env` do `settings.json` do usuário. Com perfis do cloak, é o `settings.json` do perfil, por exemplo `~/.config/cloak/profiles/<perfil>/claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/home/voce/claude-mods/outro-mod:/home/voce/claude-mods/session-radar"
  }
}
```

Se a variável já existir, acrescente `:/home/voce/claude-mods/session-radar` ao fim do valor (com o caminho absoluto da sua pasta) em vez de substituí-lo, para não descarregar os outros mods.

Também funciona exportar a variável no shell (`~/.zshrc`). O `settings.json` de um projeto (`.claude/settings.json`) **não** vale para essa variável. A mudança só tem efeito nas sessões abertas depois dela.

Não carregue o mesmo mod por dois caminhos na mesma sessão (por exemplo, pela variável e por `--plugin-dir`): seriam dois plugins com o mesmo nome.

### Teclas e botões

Com o painel focado (clique nele, ou ctrl+x tab):

| Tecla | O que faz |
| --- | --- |
| `1` a `9` | Abre o campo de mensagem para a sessão de número correspondente |
| `n` | Liga ou desliga os avisos (toasts) |
| `b` | Alterna entre o fundo escuro do mod e o fundo padrão do Claude Code |
| `r` | Atualiza na hora |

Em cada cartão de outra sessão:

- **⧉ copiar resume** copia `cd <pasta> && claude --resume <id>`.
- **⧉ copiar caminho** copia a pasta da sessão.
- **✉ mensagem** abre um campo de texto; Enter envia para aquela sessão e Enter vazio cancela.

Fora do painel, o mod também mostra:

- um resumo na status line, como `◉ 3 Claudes · 1 trabalhando`;
- toasts quando outra sessão termina o trabalho, passa a esperar você ou é fechada.

## O que cada parte mostra

| Parte | Significado |
| --- | --- |
| Corações amarelos (`5h`) | Limite de uso de 5 horas. Cada coração vale 20% e meio coração 10%. Uma metade só se apaga quando os 10% dela acabam. |
| Corações vermelhos (`7d`) | Limite semanal, com a mesma regra. |
| `90% [1h56] 18:30` | Quanto sobra, quanto falta para renovar e o horário local da renovação (no `7d`, data e hora). |
| Status do cartão | `trabalhando` (verde), `aguardando você` (amarelo, com o motivo), `ociosa` (cinza), e há quanto tempo está assim. |
| `(esta)` e borda ciano | A sessão onde o painel está aberto; ela aparece sempre primeiro. |
| `❯` | O último prompt enviado naquela sessão. |
| `ctx` | Contexto usado na última resposta e quanto falta para o limite do modelo. Verde até 60%, amarelo até 85%, vermelho acima. Um `~` antes do limite indica que ele foi estimado. |
| `Σ` | Soma de todas as respostas da sessão (entrada, incluindo cache, mais saída), incluindo subagentes. |
| `cache` | Taxa de acerto do cache, tokens lidos e escritos, e em quanto tempo o cache expira. Verde com folga, amarelo nos últimos 5 minutos, cinza quando expirou. Depois de expirar, a próxima mensagem relê o contexto inteiro sem desconto. |
| Última linha | Memória, CPU, há quanto tempo a sessão está aberta, perfil, origem (terminal ou app), versão e pid. |

## Como funciona

O Claude Code não tem uma API para listar sessões. O mod monta o painel a partir de arquivos que o próprio Claude Code já escreve, num ciclo a cada 2 segundos:

```
sessions/<pid>.json ─┐
/proc/<pid>/…        ├─► refresh() a cada 2 s ─► $.state ─┬─► painel /radar
history.jsonl        │                                    ├─► status line
transcripts .jsonl   │                                    └─► toasts
$.session.usage() ───┘
```

| Informação | Fonte |
| --- | --- |
| Lista de sessões e status | `sessions/<pid>.json` em `~/.claude` e em cada perfil de `~/.config/cloak/profiles/*/claude` (e em `CLAUDE_CONFIG_DIR`, se definido) |
| Se a sessão está viva | `/proc/<pid>/stat`: o processo precisa existir **e** ter começado na mesma hora registrada no arquivo (`procStart`). Arquivos de sessões que caíram ficam no disco, e o Linux reaproveita pids. |
| Memória e CPU | `VmRSS` de `/proc/<pid>/status` e a variação de `utime + stime` entre dois ciclos |
| Último prompt | `history.jsonl` de cada perfil, relido só quando o arquivo muda. Acima de 3,5 MB, só o final é lido. |
| Contexto, tokens e cache das outras sessões | O transcript `projects/<pasta>/<sessionId>.jsonl`, campo `usage` de cada resposta |
| Contexto e limites da sessão atual | `$.session.usage()`, direto do Claude Code |
| Mensagens | `$.session.send({ to: { sessionId } })`, o mesmo canal da ferramenta `SendMessage` |

Detalhes que valem saber:

- **Leitura incremental.** O mod guarda até onde já leu cada transcript e, a cada ciclo, lê só o trecho novo (`tail -c +offset`), até a última linha completa. Um transcript de qualquer tamanho é lido inteiro uma única vez, mesmo passando do limite de 4 MB por leitura.
- **Cada resposta conta uma vez.** O Claude grava uma resposta em várias linhas do transcript; o mod agrupa pelo id da mensagem.
- **Contexto.** É a entrada da última resposta da conversa principal (sem cache, escrita no cache e lida do cache). Respostas de subagentes entram no `Σ`, mas não no `ctx`.
- **Limite de contexto das outras sessões.** É o que o Claude Code informa para a sessão atual, reaproveitado quando o modelo é o mesmo. Para outro modelo, o mod estima 200k (ou 1M, se o contexto já passou de 200k).
- **Duração do cache.** Vem de `cache_creation.ephemeral_1h_input_tokens` ou `ephemeral_5m_input_tokens` da última resposta.
- **Fuso horário.** O ambiente do mod pode rodar em UTC, então ele pergunta o fuso ao sistema (`date +%z`) quando a sessão inicia.
- **Estado.** O que o painel desenha fica em `$.state` (sobrevive ao hot reload). A preferência do fundo fica em `$.store` (sobrevive entre sessões).

## Limitações

- Os limites de 5h e semanal são os da conta da sessão onde o painel está aberto e só se atualizam quando ela recebe uma resposta da API.
- O mod lê o histórico de prompts e os transcripts de todas as sessões. Ele não envia nada para fora, mas o painel mostra o último prompt de cada sessão: cuidado ao gravar a tela.
- Mensagens para sessões de outro perfil (outra conta) não foram testadas.

## Desenvolvimento

```
session-radar/
├── .claude-plugin/plugin.json   manifesto (nome: session-radar)
├── hooks/hooks.json             aponta para o módulo
├── hooks/register.tsx           o mod
├── types/index.d.ts             o contrato do estado ($.state)
├── tests/radar.test.tsx         testes no terminal e no desktop
├── tsconfig.json
├── .gitignore
└── README.md
```

```bash
claude plugin validate ~/claude-mods/session-radar
claude plugin test ~/claude-mods/session-radar
```

Depois que o Claude Code carrega o mod uma vez, ele gera os tipos em `.claude-plugin/types/` e `tsc -p ~/claude-mods/session-radar` passa a funcionar.
