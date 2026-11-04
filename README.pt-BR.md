# TerraCode — edição comunitária

[English](README.md) · [GitHub](https://github.com/paduartesre/terracode) · [Site do projeto](https://terracodeiac.com) · [Contato](https://terracodeiac.com/#contact)

Workspace local para editar configurações, executar Terraform e acompanhar Git e infraestrutura na mesma interface.

O TerraCode usa um frontend React no navegador e um backend Node.js na sua máquina. Os comandos são executados pelas suas instalações locais de Terraform, Git e, quando necessário, das CLIs de nuvem. O site de apresentação não executa esses comandos.

> A edição comunitária do TerraCode é software livre sob a [GNU AGPLv3](LICENSE). Código, issues e contribuições são mantidos em [paduartesre/terracode](https://github.com/paduartesre/terracode).

## 1. Pré-requisitos

Os comandos deste guia usam Bash. Execute-os em Linux, macOS ou em uma distribuição Linux dentro do WSL2. A execução nativa em Windows não foi validada por este guia. Instale Node.js, Git e Terraform no mesmo ambiente em que iniciará o backend.

| Ferramenta | Necessária para |
| --- | --- |
| Node.js 24.x com npm | Instalar e executar o TerraCode. Essa linha atende aos requisitos das dependências do lockfile consultado. |
| Git CLI | Clonar o projeto e usar o painel Git. |
| Terraform CLI | Executar os comandos de infraestrutura. Use a versão exigida pelo seu projeto. O exemplo incluído requer Terraform 1.4 ou superior. |
| Navegador atualizado | Abrir a interface local. |

Instalação das ferramentas: [Node.js](https://nodejs.org/en/download) e [Terraform](https://developer.hashicorp.com/terraform/install). Selecione a plataforma e a arquitetura corretas. Não é necessário ter uma conta de nuvem para o primeiro exemplo.

Confira as instalações no terminal que iniciará o TerraCode:

```bash
node --version
npm --version
git --version
terraform version
```

AWS CLI (`aws`), Azure CLI (`az`) ou Google Cloud CLI (`gcloud`) só são necessárias para os fluxos de login correspondentes na interface. `tfenv` e Infracost são opcionais.

## 2. Instalar e iniciar

No diretório em que você guarda seus projetos:

```bash
git clone https://github.com/paduartesre/terracode.git
cd terracode
npm ci
npm start
```

Clone o repositório com os comandos acima. Não inclua tokens na URL do repositório.

Prefere um executável? Os pacotes serão disponibilizados em [GitHub Releases](https://github.com/paduartesre/terracode/releases) após validação e publicação. Confira o sistema operacional, a arquitetura, as instruções e a versão correspondente do código em cada release; ainda não há promessa de executável para todas as plataformas.

`npm ci` usa o `package-lock.json`. `npm start` inicia dois processos no mesmo terminal:

| Processo | Endereço padrão |
| --- | --- |
| Interface Vite | `http://localhost:5173` |
| API Express | `http://localhost:3001` — escuta em `127.0.0.1` por padrão |

Abra `http://localhost:5173` e mantenha o terminal em execução. Para encerrar a sessão local, pressione `Ctrl+C` nesse terminal. Encerrar o TerraCode não desfaz alterações aplicadas à infraestrutura.

Se preferir terminais separados, use `npm run server` no primeiro e `npm run dev -- --port 5173 --strictPort` no segundo, ambos dentro de `terracode`.

> A interface atual usa a API em `http://localhost:3001`. Mantenha as portas 5173 e 3001 disponíveis. A troca automática do Vite para 5174 não funciona com a lista atual de origens permitidas da API.

## 3. Abrir seu projeto Terraform

1. Na interface, clique em **Load Terraform project…**.
2. Informe o caminho da pasta que contém os arquivos `.tf` e clique em **Go**.
3. Se aparecer **Access denied**, confira o caminho e use **Open this folder** para permitir acesso àquela pasta.
4. Clique em **Load this folder**.
5. Confira o diretório, a versão do Terraform, o workspace e o arquivo de variáveis antes de executar comandos.

Use caminhos existentes no ambiente do backend. Se o backend estiver no WSL2, use o caminho Linux correspondente; uma pasta que só existe em outra máquina não pode ser aberta.

O projeto explicitamente carregado define onde os comandos Terraform serão executados. Abrir outro arquivo no editor não troca automaticamente esse projeto carregado.

## 4. Primeiro uso, sem conta de nuvem

Crie uma pasta nova para a demonstração. Este comando não sobrescreve um projeto existente:

```bash
tc_demo_dir=$(mktemp -d "${TMPDIR:-/tmp}/terracode-demo.XXXXXX")
cat > "$tc_demo_dir/main.tf" <<'HCL'
terraform {
  required_version = ">= 1.4.0"
}

resource "terraform_data" "demo" {
  input = "TerraCode local demo"
}

output "demo_message" {
  value = terraform_data.demo.output
}
HCL
printf 'Pasta do exemplo: %s\n' "$tc_demo_dir"
```

Também há uma cópia dessa configuração em `examples/local-demo/main.tf` neste repositório. O recurso `terraform_data` é interno do Terraform e o exemplo não provisiona recursos de nuvem.

Carregue na interface a pasta mostrada no terminal e siga esta ordem:

1. **Init**: inicializa o diretório.
2. **Format**: formata os arquivos `.tf`.
3. **Validate**: valida a configuração.
4. **Plan**: mostra a criação de `terraform_data.demo`.
5. No resultado do plano, clique em **Save plan & prepare apply…** e confirme a geração de um novo `tf.plan`.
6. Use **Review saved plan** para inspecionar o plano salvo.
7. Use **Apply saved plan** e confirme a aplicação.
8. Abra **State** e **Outputs**. O output `demo_message` deve exibir `TerraCode local demo`.
9. Execute **Plan** novamente. Sem alterar o exemplo, o resultado esperado é nenhuma mudança pendente.

Para limpar somente essa demonstração, confirme primeiro que o diretório carregado é o do exemplo, use **Destroy…**, revise o plano e confirme **Apply destroy plan — delete resources**. Esse processo remove o recurso do state local da demonstração.

Em projetos reais, **Apply** e **Destroy** podem criar, alterar ou excluir infraestrutura e gerar custos. Confira sempre o diretório, o workspace, o backend e o plano antes de confirmar.

## 5. Uso diário

| Área | Como usar |
| --- | --- |
| Working Tree e editor | Pesquise e edite arquivos; crie arquivos e pastas. As gravações alteram os arquivos locais. |
| Terraform | Use Init, Format, Validate e Plan. Aplique apenas após revisar o plano salvo. |
| Workspaces e variáveis | Confira o workspace ativo. Arquivos `terraform.tfvars` e `*.auto.tfvars` são carregados pelo Terraform; outros arquivos podem ser selecionados na interface. |
| Graph e Drift | Explore dependências e verifique diferenças entre configuração e infraestrutura. Em projetos de nuvem, essas operações podem precisar de credenciais. |
| State e Outputs | Inspecione recursos e outputs. Import, movimentação e remoção de endereços são operações avançadas sobre o state. |
| Git | Confira branch, diffs e arquivos selecionados antes de fazer commit. Push, pull e fetch usam a autenticação Git disponível na máquina. |
| Registry | Consulte módulos públicos por `namespace/name/provider`. A adição grava o bloco em `modules-registry.tf` no projeto carregado. |
| Settings | Ajuste zoom, quebra de linha, fonte e tema; registre credenciais de nuvem quando precisar. |

O TerraCode não substitui as permissões do sistema operacional, do repositório remoto ou do provedor de nuvem.

## 6. Conectar uma nuvem

Para usar o login integrado, instale a CLI do provedor no ambiente do backend. Em **Settings → Cloud credentials → Register credentials…**, preencha os campos do provedor e defina uma frase-senha de pelo menos oito caracteres.

| Provedor | Credenciais aceitas pelo formulário |
| --- | --- |
| AWS | Access key ID e secret access key; session token para credenciais temporárias e região quando aplicável. |
| Azure | Client ID, client secret, tenant ID e subscription ID. |
| Google Cloud | JSON de uma conta de serviço; project ID opcional. |

Depois, abra **Login** no painel Terraform, desbloqueie o armazenamento se solicitado e autentique no provedor. O cadastro de credenciais, sozinho, não abre uma sessão autenticada. Um projeto que já utiliza a cadeia de autenticação padrão da CLI/provider pode continuar dependendo dessa configuração local.

As credenciais cadastradas são armazenadas criptografadas em `~/.terraform-code/credentials.enc`. O desbloqueio mantém uma cópia em memória por tempo limitado; o padrão é 15 minutos. **Logout** encerra a sessão do provedor na aplicação e interrompe a injeção das credenciais daquela sessão nas próximas execuções. Isso não revoga chaves no provedor nem substitui comandos de logout das CLIs.

Não envie credenciais, arquivos de state, planos ou logs com dados sensíveis em pedidos de suporte.

## 7. Recursos opcionais e configuração

`tfenv` é detectado em `~/.tfenv/bin`; com ele, você pode instalar e selecionar versões por projeto. A seleção grava `.terraform-version`. Sem `tfenv`, os comandos usam o `terraform` encontrado no `PATH`; os controles de instalação de versões dependem de `tfenv`.

Para estimativas de custo, instale Infracost e disponibilize `INFRACOST_API_KEY` no ambiente do backend. O recurso é opcional e depende do serviço Infracost.

As variáveis abaixo são lidas do processo que inicia o backend. O backend atual não carrega automaticamente um arquivo `.env`.

| Variável | Uso / padrão |
| --- | --- |
| `BASE_DIR` | Raiz principal; por padrão, a pasta do código do TerraCode. |
| `BASE_DIRS` | Raízes adicionais, separadas por `:` em ambientes POSIX. |
| `TFENV_BIN` | Diretório alternativo de binários do tfenv. |
| `TFENV_DISABLE=1` | Ignora tfenv e usa o Terraform do `PATH`. |
| `TF_TIMEOUT_MS` | Tempo máximo dos comandos Terraform; padrão `120000` ms. |
| `TF_CODE_CRED_DIR` | Diretório do armazenamento de credenciais; padrão `~/.terraform-code`. |
| `WATCH_FILES=0` | Desativa notificações de alterações externas nos arquivos. |

Exemplo, executado dentro do repositório do TerraCode:

```bash
BASE_DIR="/caminho/absoluto/do/projeto-terraform" npm start
```

A pasta deve existir. Mantenha o serviço local; a API atual executa comandos e operações em arquivos e não implementa a camada multiusuário prevista para uma futura edição SaaS.

## 8. Problemas comuns

| Sintoma | O que conferir |
| --- | --- |
| Clone negado | Confira a URL do GitHub e sua conexão com a rede. |
| Erro de versão do Node | Use Node 24.x no mesmo terminal de `npm ci` e `npm start`. |
| Interface abre, mas arquivos não carregam | Confira se a API está em execução na porta 3001; os dois processos devem permanecer ativos. |
| Interface iniciou em 5174 | Libere a porta 5173 ou use a inicialização com `--strictPort` descrita acima. |
| `terraform executable not found` ou erro de CLI | Confira `terraform version` ou a CLI do provedor no terminal do backend. Reinicie o TerraCode após ajustar o `PATH`. |
| `Access denied` em uma pasta | Use **Open this folder** após confirmar o caminho. Links simbólicos para fora das raízes permitidas também podem ser recusados. |
| Login indisponível ou falhou | Confira CLI instalada, frase-senha, credenciais e permissões no provedor. |
| Arquivo mudou fora do editor | Recarregue e compare antes de salvar; a API detecta conflitos de gravação. |
| Comando demorou e foi encerrado | Inspecione o log e o state antes de repetir: encerrar o processo não garante que uma operação remota foi desfeita. |

## 9. Atualizar e verificar o projeto

Dentro do repositório, encerre o TerraCode, confira seu `git status` e preserve alterações locais antes de atualizar. Se estiver em `main`, sem mudanças locais e sem divergência:

```bash
git pull --ff-only
npm ci
npm start
```

A CI executa build, lint, testes e cobertura nos pull requests. Consulte o [guia do mantenedor](docs/MAINTAINER.md) para comandos, cobertura inicial e artefatos.

Para contribuidores, os scripts existentes são `npm run build`, `npm run lint` e `npm test`. A suíte `tests/integration/terraform.test.ts` usa uma API em execução em `http://localhost:3001`; inicie `npm run server` em outro terminal antes de `npm test`. A suíte de backend em `server.test.mjs` usa a configuração específica:

```bash
npx vitest run --config vitest.server.config.mts
```

## 10. Participar e obter ajuda

Use o TerraCode, relate problemas, faça fork e proponha melhorias pelo [GitHub](https://github.com/paduartesre/terracode). Consulte o fluxo em [CONTRIBUTING.md](CONTRIBUTING.md). A participação na comunidade não exige seleção nem convite.

A participação na comunidade é voluntária, gratuita e sem remuneração.

Ao relatar um problema, informe sistema operacional, método de instalação, versão ou commit do TerraCode, versão do Terraform, versão do Node se executar pelo código, passos para reproduzir, resultado esperado e mensagem de erro sem segredos. Use as [issues do GitHub](https://github.com/paduartesre/terracode/issues) para problemas reproduzíveis. Para relatos sensíveis ou contato direto, fale com Pedro Duarte pelo e-mail [pedroduarte@terracodeiac.com](mailto:pedroduarte@terracodeiac.com), pelo [site](https://terracodeiac.com/#contact) ou pelo [LinkedIn](https://www.linkedin.com/in/duarpadevops).

A edição comunitária é destinada ao uso local. SaaS empresarial, provisionamento de pipelines, governança multiusuário e integrações empresariais de segurança são planos de evolução, não recursos disponíveis nesta versão.

## 11. Licença e autoria

Copyright (c) 2026 Pedro Duarte. O TerraCode está licenciado sob a [GNU Affero General Public License, somente versão 3](LICENSE) (`AGPL-3.0-only`), sem garantia. Preserve os avisos aplicáveis de copyright e licença ao redistribuir. O uso comercial é permitido sob a licença; ela não exige o envio de contribuições a este repositório.

Versões cobertas redistribuídas devem disponibilizar seu código correspondente sob a licença. Versões modificadas usadas para interação pela rede devem oferecer seu código correspondente àqueles usuários, conforme a seção 13. Releases de executáveis devem fornecer acesso ao código e às instruções de build correspondentes. Componentes de terceiros mantêm suas próprias licenças.
