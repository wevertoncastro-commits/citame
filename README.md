# Citame

Gerenciador local de artigos, arquivos e referências acadêmicas com formatação ABNT/APA. A aplicação funciona sem conta na nuvem: os dados ficam em SQLite e os anexos são guardados na pasta do projeto.

## Abrir no Windows

1. Instale o [Node.js LTS 22.13 ou mais recente](https://nodejs.org/).
2. Execute `start-local.bat` (na primeira vez, ele instala as dependências).
3. O navegador abrirá em <http://localhost:3000>. Para encerrar, use `Ctrl+C` na janela do servidor.

Também é possível iniciar pelo terminal:

```powershell
npm install --legacy-peer-deps
npm run dev
```

Abra <http://localhost:3000>. O servidor usa SQLite local por padrão quando as variáveis do Supabase não estão configuradas. O banco persistente é `academic_library.sqlite`. Os anexos são preservados no formato original em subpastas por tipo dentro de `Citame-Biblioteca`, com seus arquivos `.citame.json` de metadados na mesma pasta. Exemplos: `Citame-Livro`, `Citame-Artigo` e `Citame-Capítulo`; pastas são criadas somente quando há arquivos daquele tipo. O menu **Arquivo > Adicionar arquivos** permite importar uma obra dessa biblioteca e recuperar os metadados.

A raiz de `Citame-Biblioteca` também contém `minhas-notas.json` (textos criados na seção **Anotações**) e `0.Minha-biblioteca.json`, um backup atualizado automaticamente com referências, coleções, perfil, citações do suplemento Word, anotações e metadados dos anexos. Os arquivos originais não são incorporados ao backup. Para transferir a biblioteca, copie também as subpastas `Citame-*` para a pasta `Citame-Biblioteca` do outro computador e importe `0.Minha-biblioteca.json` pelo gerenciador de banco de dados.

## Funcionalidades

- Cadastro, edição e organização de referências e coleções.
- Cadastro de livros com subtítulo e série, preservados no banco SQLite e nos metadados do arquivo.
- Geração de citações ABNT e APA e exportação BibTeX/RIS.
- Duplo clique no título da obra para abrir o arquivo original no leitor. Em PDFs locais, clique em uma posição da página para criar uma nota vinculada a esse ponto; os marcadores aparecem sobre o PDF e as notas são salvas no arquivo `.citame.json` local. Os painéis de navegação e notas começam recolhidos.
- Leitura contínua de PDFs com rolagem entre páginas, zoom e miniaturas roláveis para navegar diretamente; o ícone de miniaturas fica na barra lateral do leitor, onde o ícone do banco de dados é ocultado. Outros formatos anexados podem ser baixados.
- Criação, edição e exclusão de textos na seção **Anotações**, salvos em `Citame-Biblioteca\minhas-notas.json`.
- **Pesquisa Bíblica** com busca de livro/capítulo/versículo, texto NAA, interlinear hebraico ou grego sob o texto em português (controlado pelos botões HEB/GRE); ao passar o cursor sobre uma palavra HEB/GRE, a transliteração e o gloss são apresentados em português, seguidos pelo gloss inglês entre parênteses. Inclui resumos e comentários locais em português e inglês, com filtros por fonte e referência; na aba **Original**, o gloss é apresentado em português/inglês e a morfologia é descrita em português, preservando termos gramaticais hebraicos como qal e piel. **Dicionário Bíblico** com pesquisa Strong em hebraico e grego.
- As fontes locais de comentários são disponibilizadas como obras na biblioteca: cada fonte e idioma aparece na coleção **Comentários Bíblicos** e pode ser lida por livro e capítulo. Os textos podem ser selecionados e copiados, e trechos destacados com notas persistidas nos metadados `.citame.json`. Os textos ficam em `Citame-Biblioteca\Citame-Comentários`. O **Dicionário Bíblico Strong** também aparece como obra navegável na coleção própria **Dicionário Bíblico Strong**.
- Backup local automático em `Citame-Biblioteca\0.Minha-biblioteca.json`, restauração e exploração somente leitura do banco SQLite.
- Extração de metadados assistida por IA quando `GEMINI_API_KEY` está configurada; sem a chave, a aplicação continua funcionando com extração local heurística.

Os textos e dicionários bíblicos ficam em `public\bible-data`, e os comentários são consultados pelas rotas locais do Citame. Os comentários preservam sua fonte, idioma e referência por livro, capítulo e versículo, sem depender da instalação do Textos-Reavivados. O interlinear hebraico do Antigo Testamento e o grego do Novo Testamento são servidos pelo banco local `public\bible-data\greek_bible.db`.

## Integrações opcionais

### Gemini

Defina `GEMINI_API_KEY` no ambiente ou em um arquivo `.env` local para habilitar a extração com Gemini. A chave não é necessária para abrir ou usar a aplicação localmente.

### Microsoft Word para Windows

O suplemento funciona no Word Desktop para Windows e usa a biblioteca SQLite local do Citame. Para configurá-lo:

1. Crie ou edite o arquivo `.env` na raiz do projeto e defina `CITAME_WORD_API_TOKEN` com um segredo aleatório. Para gerar um no PowerShell, execute `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Não compartilhe nem publique esse token.
2. Na raiz do projeto, execute `npm install --legacy-peer-deps` para instalar as dependências e depois `npm run word:addin:trust-cert` para instalar o certificado HTTPS de desenvolvimento. Faça isso na primeira configuração e confirme qualquer solicitação do Windows.
3. Inicie o Citame com `start-local.bat`. Esse atalho mantém a aplicação em `http://localhost:3000` e disponibiliza o painel do suplemento em `https://localhost:3443`. Se iniciar pelo terminal, use `$env:CITAME_WORD_ADDIN_HTTPS_PORT=3443; npm run dev`.
4. No Word, carregue `word-addin/manifest.xml` usando **Inserir > Suplementos > Meus Suplementos > Carregar Meu Suplemento**. A disponibilidade desse comando pode variar conforme a versão do Office; também é possível configurar a pasta do projeto como catálogo confiável de suplementos.
5. Na guia **Referências**, abra **Citame**, informe o mesmo token configurado no `.env` e conecte-se à biblioteca.

As citações são mantidas como controles identificados no documento, e a bibliografia pode ser atualizada pelo painel. Os metadados dessas citações ficam no banco local `academic_library.sqlite`; mantenha esse banco junto do documento para continuar editando as citações em outra instalação. Estão disponíveis ABNT, APA 7ª edição, Vancouver (estilo Elsevier/NLM) e IEEE.

O servidor do suplemento escuta somente em `localhost`. O token é guardado na sessão atual do painel do Word e a API o exige em todas as chamadas.

## Publicar na Vercel com Supabase

O modo online usa PostgreSQL e Storage do Supabase. No modo local continuam sendo usados `academic_library.sqlite` e a pasta `Citame-Biblioteca`.

1. Crie um projeto no [Supabase](https://supabase.com/).
2. Abra **SQL Editor**, cole o conteúdo de `supabase/schema.sql` e execute.
3. Em **Project Settings > API**, copie `Project URL`, `anon public key` e `service_role key`.
4. Em **Project Settings > Database**, copie a URL de conexão do pooler. Use a opção de pooler de sessão/transação compatível com aplicações serverless.
5. Importe o repositório na Vercel, mantendo a raiz do projeto.
6. Configure na Vercel:

```text
SUPABASE_URL
SUPABASE_PUBLISHABLE_KEY  # ou SUPABASE_ANON_KEY
SUPABASE_SECRET_KEY       # ou SUPABASE_SERVICE_ROLE_KEY
SUPABASE_DATABASE_URL
SUPABASE_STORAGE_BUCKET=citame-library
```

Se você usou **Add Integration > Supabase** na Vercel, a conexão PostgreSQL também pode chegar como `POSTGRES_URL`; o Citame reconhece essa variável automaticamente.

7. Opcionalmente configure `GEMINI_API_KEY`.
8. Confirme **Build Command** como `npm run build` e faça o deploy.

Não exponha `SUPABASE_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY` nem a URL do banco em variáveis com prefixo `VITE_`. Elas são usadas somente pela função do servidor. O upload de PDFs é assinado pelo servidor e enviado diretamente ao Storage pelo navegador, evitando o limite de corpo das funções Vercel.

As APIs do suplemento Word continuam disponíveis somente no modo local com SQLite; não configure ou publique o manifesto do Word para o endereço Vercel.

### Créditos e licenças

O motor de citações `citeproc-js` é distribuído sob CPAL-1.0 ou AGPL-1.0; consulte a licença incluída no pacote e escolha os termos aplicáveis à distribuição do projeto. Os estilos CSL ABNT, APA, Elsevier/Vancouver e IEEE e os arquivos de locale pt-BR/en-US incluem, em seus metadados, licença CC BY-SA 3.0 e atribuições aos autores e contribuidores. Os arquivos originais estão em `public/word-addin/styles` e `public/word-addin/locales`.

## Aplicação Streamlit alternativa

O arquivo `app.py` é uma interface Streamlit separada, mantida para compatibilidade. Para usá-la, instale `requirements.txt` e execute `streamlit run app.py`.
