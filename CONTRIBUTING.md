# Contributing to TerraCode / Como contribuir

## English

The community repository is [paduartesre/terracode](https://github.com/paduartesre/terracode). GitLab is the maintainer's private development repository; contributors do not need access to it.

You can help by testing local workflows, improving documentation, reporting reproducible problems, or proposing code changes. No invitation or selection is required for community participation. Participation is voluntary, free of charge, and unpaid.

1. Follow [README.md](README.md) to install from source and try the cloud-free example first. If using an executable release, follow its included instructions.
2. Search existing [issues](https://github.com/paduartesre/terracode/issues) before opening one. Include the operating system, installation method, TerraCode version or commit, Terraform version, Node version if applicable, reproduction steps, expected result, and actual result.
3. For code changes, fork the GitHub repository, create a focused branch from `main`, and keep unrelated formatting or dependency updates out of the diff. Discuss larger changes in an issue before implementing them.
4. Run the checks relevant to the change. See the README and [maintainer guide](docs/MAINTAINER.md) for build, lint, coverage and test commands. The integration suite requires a running API; test infrastructure changes only on disposable or explicitly authorized resources.
5. Open a pull request against `main` describing the problem, change, and checks performed. Maintainer review determines what is included in official releases.

Contributions must be yours to submit and provided under the project's [AGPL-3.0-only license](LICENSE). Preserve third-party license notices and identify any added third-party material. Submitting a contribution does not transfer ownership of it.

Never include credentials, tokens, private keys, Terraform state, saved plans, or client data in issues or pull requests. Send sensitive security reports privately to [pedroduarte@terracodeiac.com](mailto:pedroduarte@terracodeiac.com). For general questions, use the project contact page.

## Português (Brasil)

O repositório comunitário é [paduartesre/terracode](https://github.com/paduartesre/terracode). O GitLab é o repositório privado de desenvolvimento do mantenedor; não é necessário acessá-lo para contribuir.

Você pode ajudar testando fluxos locais, melhorando a documentação, relatando problemas reproduzíveis ou propondo alterações no código. A participação na comunidade não exige convite nem seleção. A participação é voluntária, gratuita e sem remuneração.

1. Siga o [README.pt-BR.md](README.pt-BR.md) para instalar pelo código e comece pelo exemplo sem nuvem. Para executáveis, siga as instruções incluídas na release.
2. Consulte as [issues](https://github.com/paduartesre/terracode/issues) antes de abrir uma. Informe sistema operacional, método de instalação, versão ou commit do TerraCode, versão do Terraform, versão do Node quando aplicável, passos para reproduzir, resultado esperado e resultado obtido.
3. Para alterações de código, faça fork do GitHub, crie uma branch a partir de `main` e mantenha o diff focado, sem formatação ou atualização de dependências não relacionadas. Combine mudanças maiores em uma issue antes de implementar.
4. Execute as verificações relevantes. Consulte no README e no [guia do mantenedor](docs/MAINTAINER.md) os comandos de build, lint, cobertura e testes. A suíte de integração exige a API em execução; teste alterações de infraestrutura apenas em recursos descartáveis ou explicitamente autorizados.
5. Abra um pull request para `main` descrevendo problema, alteração e verificações realizadas. A revisão pelo mantenedor define o que entra nas releases oficiais.

As contribuições devem ser suas ou você deve ter autorização para enviá-las, sob a licença [AGPL-3.0-only](LICENSE) do projeto. Preserve os avisos de licença e identifique materiais de terceiros adicionados. Contribuir não transfere a titularidade da sua contribuição.

Não envie credenciais, tokens, chaves privadas, state do Terraform, planos salvos ou dados de clientes em issues ou pull requests. Relatos sensíveis de segurança devem ser enviados em particular para [pedroduarte@terracodeiac.com](mailto:pedroduarte@terracodeiac.com). Para dúvidas gerais, use a página de contato do projeto.
