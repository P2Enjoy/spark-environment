# Conversation d'origine — « Design Spark Control Plane »

Transcription intégrale de la conversation ChatGPT qui a défini l'idée de ce dépôt.

Source : `https://chatgpt.com/share/6a8482ca-0700-83eb-a0d4-0d72a932464b`
Extraite le 2026-08-18 depuis la charge utile embarquée de la page de partage.

Ce document existe parce qu'un lien de partage peut disparaître à tout moment et
qu'une idée fondatrice ne doit jamais dépendre d'une seule URL externe. Il est
conservé **verbatim** : il n'est ni corrigé, ni actualisé, ni harmonisé avec les
décisions ultérieures. Les décisions qui font foi pour l'implémentation sont
consignées dans `docs/DAT.md`, `docs/SCHEMA.md` et `docs/JOURNAL.md`.

Ont été retirés de la transcription, car sans valeur documentaire :

- les appels d'outils de recherche web du modèle ;
- les réponses d'outils, toutes marquées « The output of this plugin was redacted. » ;
- les marqueurs de citation internes de la forme `citeturnNNN`, qui renvoyaient
  tous à la documentation Incus (les faits correspondants ont été revérifiés
  directement à la source, voir `docs/JOURNAL.md`).

---

## 1. Question du responsable

what if I already have industrialised my apps to fully run in a docker compose with theirs services and variables and the only thing I need is a webui that allows me to split in fully separate sections a big server and only inject the ingress rules (this domains belongs to this spark). A spark is a fully isolated container (but not a docker, because we will install an run dockers inside a spark), like a 0.5CPU (from a pool on 4 available on the server) and 16go of ram (from a pool of say 256) and 100mbps (from a pool of 3gbps) and 10Go (from a pool of 6to).

So basically, I want a simple mechanics and an administrative webui I run locally but administer the distant via ssh on a private 127.0.0.1 only admin api to create, run, backup, stop and delete sparks on a machine. I was thinking of ltx but I am not sure if anything similar actually exists.
The administration will also provide me an administrative ssh management here I can push ssh keys so I can ssh directly into the sparks to deploy my dockers compose stacks.

You see where I am going?

## 2. Réponse

Oui, je vois très précisément la cible : tu ne veux pas un orchestrateur de conteneurs applicatifs, tu veux un **partitionneur de machine en “mini-hôtes Docker” fortement isolés**, avec quotas, réseau, stockage, SSH et routage ingress. Je vais vérifier ce qui existe déjà au niveau “system containers / microVM” avant de te dire si ton concept de *Spark* mérite d’être développé.

## 3. Réponse

Premier constat : **Incus est presque exactement le moteur que tu décris**, bien plus que Docker, Kubernetes ou une plateforme FaaS. Il appelle cela des *system containers* : ce sont des environnements Linux complets dans lesquels Docker peut tourner, avec limites CPU/RAM/disque/réseau, snapshots, exports et API. 

La vraie question devient donc moins « comment construire Spark ? » que « quelle fine couche de contrôle ajouter au-dessus d’Incus pour obtenir exactement ton modèle Spark + ingress + clés SSH + comptabilité des pools ? ».

## 4. Réponse

Il y a aussi un point important sur ton mot « fully isolated ». Un Spark basé sur Incus/LXC peut être **très fortement cloisonné** et non privilégié, avec des UID/GID distincts par Spark, mais il partage toujours le kernel hôte. Incus permet précisément `security.idmap.isolated` pour éviter le recouvrement des mappings entre conteneurs. 

Donc je ferais le moteur Spark **bi-mode** dès le départ : `container` pour tes propres workloads de confiance, `vm` pour du code réellement hostile ou multi-tenant. Incus gère les deux via la même abstraction, ce qui t’évite de changer ton control plane plus tard.

## 5. Réponse

Yes. What you are describing is essentially a **very small private VPS control plane**, except the “VPS” is optimized for running Docker Compose rather than pretending to be a generic virtual machine.

And I would not build the isolation/runtime layer myself. I would build **Spark as a thin opinionated layer over Incus**.

If by “LTX” you meant **LXC**, I would also avoid using raw LXC directly. Incus is the management layer around Linux system containers that gives you the lifecycle, API, resource controls, storage and networking primitives you would otherwise have to reinvent. Incus is Apache 2.0 and remains a community open source project. cite

Your architecture would look roughly like this:

```text
                         INTERNET
                            │
                      80 / 443 only
                            │
                    ┌───────▼────────┐
                    │      Caddy     │
                    │ host ingress   │
                    └───────┬────────┘
                            │
          ┌─────────────────┼──────────────────┐
          │                 │                  │
     app1.foo.com       app2.foo.com      app3.foo.com
          │                 │                  │
     10.10.0.11          10.10.0.12        10.10.0.13
          │                 │                  │
   ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
   │   SPARK A   │   │   SPARK B   │   │   SPARK C   │
   │ Incus CT    │   │ Incus CT    │   │ Incus CT    │
   │             │   │             │   │             │
   │ Docker      │   │ Docker      │   │ Docker      │
   │ Compose     │   │ Compose     │   │ Compose     │
   │             │   │             │   │             │
   │ 0.5 CPU     │   │ 1 CPU       │   │ 2 CPU       │
   │ 16 GiB      │   │ 32 GiB      │   │ 64 GiB      │
   │ 10 GiB      │   │ 40 GiB      │   │ 100 GiB     │
   │ 100 Mbps    │   │ 250 Mbps    │   │ 500 Mbps    │
   └─────────────┘   └─────────────┘   └─────────────┘
```

The important conceptual point is that **Docker is no longer your tenancy/isolation boundary**. Docker belongs to the tenant environment. The Spark is the boundary.

That is a very clean architecture.

A Spark definition could be as simple as:

```yaml
name: production-crm

resources:
  cpu: 0.5
  memory: 16GiB
  disk: 10GiB
  network: 100Mbit

ingress:
  - domain: crm.example.com
    port: 80

ssh_keys:
  - martino-laptop
  - deploy-ci

runtime:
  type: container
  docker: true
```

Your control plane translates that into Incus configuration.

For the CPU specifically, don't implement `0.5 CPU` as a vague scheduling weight. Incus supports hard CFS quotas using a time allowance. `50ms/100ms` means half of one CPU worth of execution time. A percentage such as `50%` is only a soft scheduling limit, so I would explicitly use the time form for Spark capacity accounting. cite

So:

```text
Spark CPU:       0.5
Incus:           limits.cpu.allowance=50ms/100ms

Spark RAM:       16 GiB
Incus:           limits.memory=16GiB

Spark network:   100 Mbit/s
Incus NIC:       limits.max=100Mbit

Spark disk:      10 GiB
Incus root disk: size=10GiB
```

Incus natively exposes ingress/egress NIC rate limits, and its root filesystem disk device supports a `size` quota. cite

For Docker inside the Spark, this is an explicitly supported Incus scenario. You enable nesting:

```text
security.nesting=true
```

Incus documents Docker inside system containers directly. cite

I would additionally create Sparks unprivileged and use:

```text
security.idmap.isolated=true
```

so Spark A and Spark B don't even share overlapping host UID/GID mappings. Incus specifically recommends this where data sharing between containers isn't needed. cite

The resulting hierarchy is therefore:

```text
physical server
    │
    ├── Spark A
    │      └── dockerd
    │            ├── frontend
    │            ├── backend
    │            ├── postgres
    │            └── redis
    │
    ├── Spark B
    │      └── dockerd
    │            ├── app
    │            └── mysql
    │
    └── Spark C
           └── dockerd
                 └── ...
```

This is much better suited to your existing industrialized Compose stacks than converting everything to Kubernetes primitives.

For the resource pool, however, I would deliberately put the accounting logic in **Spark**, not delegate it entirely to Incus.

Your server might expose:

```text
CPU pool:        4.0
RAM pool:        256 GiB
Storage pool:    6 TiB
Network pool:    3 Gbit/s
```

and your own DB keeps:

```text
allocated CPU:      2.5 / 4.0
allocated RAM:      112 / 256 GiB
allocated disk:     1.7 / 6 TiB
allocated network:  1.1 / 3 Gbit/s
```

When someone requests:

```text
0.5 CPU
16 GiB
10 GiB
100 Mbit
```

Spark performs admission control first.

Only then does it create the Incus instance.

That distinction matters because Linux cgroups enforce limits, whereas **your Spark scheduler determines whether capacity has already been allocated**. You can then make overcommit an explicit configuration rather than an accidental side effect.

I would also absolutely use ZFS for the Incus storage pool in this use case. Incus supports ZFS quotas, snapshots and instance backups. Instance snapshots can be restored, while `incus export` produces portable backup tarballs. cite

That gives your UI exactly the operations you described:

```text
CREATE
START
STOP
RESTART
SNAPSHOT
BACKUP
RESTORE
RESIZE
DELETE
```

without you implementing container filesystem semantics.

The ingress part is also simpler than involving Incus itself.

I would run **one Caddy instance on the physical host**.

Spark A exposes something like:

```text
10.77.0.4:80
```

Spark B:

```text
10.77.0.5:80
```

Your Spark database contains:

```text
foo.example.com   -> spark-a:80
api.example.com   -> spark-b:80
```

and your agent modifies Caddy.

Caddy's administrative API can dynamically mutate individual sections of its active JSON configuration, with zero-downtime application of valid changes. Its examples use the local API on `localhost:2019`, which fits your localhost-only management philosophy extremely well. cite

And because Caddy knows the hostname, it can handle certificate issuance and renewal automatically. cite

So your external attack surface remains basically:

```text
22/tcp     SSH administration
80/tcp     HTTP
443/tcp    HTTPS
```

Everything else:

```text
Incus API       127.0.0.1
Spark API       127.0.0.1
Caddy API       127.0.0.1
database        127.0.0.1 / Unix socket
```

Incus itself already behaves nicely here. By default its daemon is accessible through a local Unix socket and is not network-exposed unless `core.https_address` is configured. cite

If you specifically want the API on TCP localhost, you can bind it there and SSH tunnel it.

I would actually build the administration plane like this:

```text
YOUR LAPTOP
┌──────────────────────────────┐
│ Spark WebUI                  │
│ http://127.0.0.1:xxxx        │
│                              │
│ spark-controller             │
└──────────────┬───────────────┘
               │ SSH
               │ encrypted tunnel
               ▼
SERVER
┌──────────────────────────────┐
│ sshd                         │
│                              │
│ 127.0.0.1:9876 sparkd        │
│ 127.0.0.1:8443 incus         │
│ 127.0.0.1:2019 caddy         │
└──────────────────────────────┘
```

The browser never needs to understand SSH.

Your **local backend** does.

Something equivalent to:

```text
ssh server \
    -L 19876:127.0.0.1:9876 \
    -L 18443:127.0.0.1:8443
```

Then the WebUI simply sees:

```text
http://127.0.0.1:19876
```

This gives you a particularly nice security property: **there is literally no Spark administration API accessible from the network**.

Only somebody capable of authenticating over SSH can reach it.

For SSH into Sparks themselves, I would not allocate public SSH ports to every Spark.

Use the physical host as a bastion:

```text
Laptop
   │
   │ SSH
   ▼
Physical host
   │
   │ private bridge
   ▼
Spark
```

Then generate an SSH config such as:

```sshconfig
Host spark-crm
    HostName 10.77.0.4
    User root
    ProxyJump spark-host
    IdentityFile ~/.ssh/spark-crm
```

From your point of view:

```bash
ssh spark-crm
```

and you're in.

No public port mappings.

No extra firewall rules.

No exposed SSH daemon except the server's own SSH endpoint.

For provisioning, the Spark creator can inject your selected public keys during initialization using cloud-init, which Incus supports for instance initialization. cite

Your UX could therefore literally be:

```text
SPARKS

production-crm
● Running

0.5 / 0.5 CPU
6.7 / 16 GiB RAM
6.2 / 10 GiB disk
18 / 100 Mbit

crm.example.com
www.crm.example.com

[ Terminal ]
[ SSH Keys ]
[ Ingress ]
[ Snapshot ]
[ Backup ]
[ Stop ]
```

And creating one:

```text
NEW SPARK

Name
[________________]

CPU
[ 0.5 ]       Available: 1.5 / 4

Memory
[ 16 GiB ]    Available: 96 / 256 GiB

Storage
[ 10 GiB ]    Available: 4.3 / 6 TiB

Bandwidth
[ 100 Mbit ]  Available: 1.9 / 3 Gbit

Base image
[ Debian 13 ▼ ]

SSH keys
☑ Martino Laptop
☑ GitHub deploy
☐ CI runner

[ Create Spark ]
```

Behind that button, you're essentially doing:

```text
allocate resources
        ↓
incus init
        ↓
configure cgroups
        ↓
configure isolated uidmap
        ↓
configure private NIC
        ↓
configure storage quota
        ↓
inject SSH keys
        ↓
enable nesting
        ↓
install Docker + Compose
        ↓
start Spark
        ↓
persist Spark metadata
```

That's it.

One thing I would **not** do is have every Compose stack manage the host reverse proxy using Docker labels, Traefik sockets, `/var/run/docker.sock`, etc.

That starts coupling your host control plane back to the tenant Docker runtime.

I'd impose one simple Spark contract instead:

```text
Every Spark owns a private IP.

Every ingress declaration is:

domain -> spark -> port
```

For example:

```text
crm.p2enjoy.studio
    -> spark:crm-production
    -> 10.77.0.14:8080
```

Your Compose file remains completely ordinary:

```yaml
services:
  web:
    ...
    ports:
      - "8080:8080"
```

but `8080` is reachable only on the Spark's private interface.

Caddy owns public exposure.

That's a very strong separation of concerns.

The only qualification I'd make concerns **hostile workloads**. An Incus system container is not equivalent to a VM because all system containers share the host kernel. Incus containers are unprivileged by default, which substantially reduces the attack surface, but it is still a shared-kernel architecture. cite

For your own applications, I'd absolutely use it.

If eventually you allow arbitrary customers to upload arbitrary Compose stacks, your Spark model should support:

```text
isolation: container
```

and:

```text
isolation: vm
```

with exactly the same WebUI.

Incus already supports both system containers and VMs, so the abstraction holds. cite

That is actually one of the strongest reasons I'd select Incus.

So my stack would be:

```text
Spark UI                 your code
Spark controller         your code
sparkd                    very small Go/Rust daemon
Resource ledger          SQLite initially
Incus                     isolation + lifecycle
ZFS                       storage
Caddy                     ingress + TLS
OpenSSH                   management transport
Docker Engine             inside each Spark
Docker Compose            inside each Spark
```

No Kubernetes.

No Nomad.

No OpenStack.

No Proxmox management layer.

No Docker socket exposed to your control plane.

No public administrative API.

And the amount of code that is genuinely yours becomes surprisingly small.

**This is much closer to building a tiny Hetzner/DigitalOcean control plane than building a PaaS.** Your unit of deployment isn't an application or function. It is a quota-controlled Linux execution cell whose primary purpose is to host an already-industrialized Docker Compose stack.

I think **Spark is actually a very good abstraction for it**. Incus is the machinery underneath, while Spark is the opinionated product model on top.

## 6. Question du responsable

would it be possible to have shared cpus instead of fully dedicated?

## 7. Réponse

Yes. And for your model, I would actually prefer **shared CPU by default**.

Incus does not require you to dedicate or pin physical cores to a Spark. If you do not set `limits.cpu` to a CPU range, the Spark can run on the host's shared CPU pool. Incus uses Linux cgroups to arbitrate CPU time between containers. cite

So on a 4 CPU server, you could conceptually have:

```text
HOST
4 physical/logical CPUs
████████████████████████████████

Spark A   0.5 CPU
Spark B   0.5 CPU
Spark C   1.0 CPU
Spark D   0.25 CPU
Spark E   0.75 CPU
Spark F   1.0 CPU
────────────────
allocated: 4.0 CPU
```

But none of those means:

```text
Spark A -> CPU #0
Spark B -> CPU #1
```

They all execute across the scheduler's CPU pool.

There are actually two very interesting modes available.

### 1. Shared CPU with hard quotas

For your `0.5 CPU` example:

```text
limits.cpu.allowance=50ms/100ms
```

That means the Spark can execute on shared host CPUs, but in aggregate it cannot consume more than **half of one CPU worth of CPU time**. Incus explicitly implements time constraints such as `20ms/50ms` as hard CFS quotas. cite

So:

```text
Host: 4 CPUs

Spark A:
    CPU quota = 0.5

Spark A process scheduling:

CPU0   ███░░░░
CPU1   ░░██░░░
CPU2   ░░░░██░
CPU3   ░░░░░░█

aggregate CPU time <= 0.5 CPU
```

It isn't tied to one core.

And importantly, Incus itself recommends avoiding `limits.cpu` when using this kind of time quota because combining CPU pinning with time quotas unnecessarily constrains the scheduler. cite

So I'd change what I proposed earlier to:

```text
DON'T:

limits.cpu=1
limits.cpu.allowance=50ms/100ms


DO:

limits.cpu.allowance=50ms/100ms
```

That is much closer to your Spark abstraction.

---

### 2. Shared CPU with bursting

This one may be even more interesting for you.

Incus also accepts percentages:

```text
limits.cpu.allowance=50%
```

Unlike the time quota, a percentage is a **soft scheduling limit**. It determines the Spark's share relative to competing instances when the machine is under CPU pressure. cite

Meaning you can have:

```text
Spark A: 0.5 CPU
Spark B: 0.5 CPU
Spark C: 1 CPU
Spark D: 2 CPU
```

When everybody is busy:

```text
A      12.5%
B      12.5%
C      25%
D      50%
```

But when only Spark A is doing work, you don't necessarily need to leave the other CPU capacity idle.

That's exactly how I'd want a small PaaS/VPS-like system to behave.

You can additionally set:

```text
limits.cpu.priority
```

from `0` to `10`, which Incus specifically provides to influence scheduling between containers sharing CPUs when resources are overcommitted. cite

So Spark could expose a much nicer abstraction than Incus itself:

```yaml
resources:
  cpu:
    reservation: 0.5
    mode: shared
```

And internally:

```text
Spark scheduler
        ↓
Incus cgroup CPU shares
        ↓
Linux scheduler
        ↓
4 host CPUs
```

I would probably go one step further and make the Spark model:

```yaml
cpu:
  reservation: 0.5
  burst: true
  priority: normal
```

Then you have:

```text
reservation
    = what Spark uses for capacity accounting

burst
    = whether it may consume unused CPU

priority
    = arbitration under contention
```

For example:

```text
SERVER
4 CPU capacity

Spark A
reservation: 0.5
burst: true

Spark B
reservation: 0.5
burst: true

Spark C
reservation: 1
burst: true
```

Spark sees:

```text
Allocated       2.0 CPU
Available       2.0 CPU
Physical        4.0 CPU
```

But at 03:00, if A, B and C are basically idle and Spark C suddenly has a compilation job:

```text
Spark C
reservation    1 CPU
actual use     3.6 CPU
```

Perfectly fine.

Then when everything wakes up:

```text
              reservation     current entitlement

Spark A          0.5                 0.5
Spark B          0.5                 0.5
Spark C          1.0                 1.0
Spark D          2.0                 2.0
                                     
TOTAL            4.0                 4.0
```

The kernel scheduler brings everyone back toward their weighted entitlement.

That is, in my view, **considerably better than dedicating CPUs** for your use case.

I'd actually extend the concept to your whole Spark resource model:

```yaml
resources:

  cpu:
    reservation: 0.5
    burst: true

  memory:
    reservation: 16GiB
    max: 20GiB

  network:
    reservation: 100Mbit
    burst: 500Mbit

  storage:
    size: 10GiB
```

Then your host becomes an actual resource pool:

```text
                       PHYSICAL
CPU                     4.0
RAM                     256 GiB
NETWORK                 3 Gbit
STORAGE                 6 TiB

                         │
                         ▼

                  SPARK RESOURCE POOL

       ┌────────────┬────────────┬────────────┐
       │            │            │            │
       ▼            ▼            ▼            ▼

     Spark A      Spark B      Spark C      Spark D
      0.5          1.0          0.25         0.5
      CPU          CPU          CPU          CPU

             all sharing the same CPUs
```

And there is another nice detail: if you ever *do* need dedicated CPUs for something latency-sensitive, Incus supports that too. Specifying actual CPU IDs such as `0-3` pins an instance, whereas specifying a count lets Incus dynamically balance CPUs among unpinned instances. cite

So your eventual API could support:

```yaml
cpu:
  mode: shared
  reservation: 0.5
```

or:

```yaml
cpu:
  mode: capped
  max: 0.5
```

or, for special workloads:

```yaml
cpu:
  mode: dedicated
  cores: 2
```

But **`shared + burst` should be the default Spark model**.

For your typical Compose deployments, web servers, APIs, Redis, PostgreSQL, workers, CRONs, etc., dedicating cores would waste enormous amounts of capacity because almost all those applications are bursty rather than continuously CPU-bound.

And this gives Spark a very elegant semantics:

> **“0.5 Spark CPU” means 0.5 CPU of guaranteed scheduling entitlement under contention, not half of a physical core permanently reserved.**

That's much closer to what I think you actually want.

## 8. Question du responsable

but how I combine that with a spark if it requires a special dedicated cpu while the other sparks are sharing?

## 9. Réponse

Yes. The clean way is to make **Spark itself manage two CPU pools**:

```text
HOST: 8 logical CPUs

CPU 0  ┐
CPU 1  │
CPU 2  │  SHARED POOL
CPU 3  │
CPU 4  │
CPU 5  ┘

CPU 6  ┐  DEDICATED POOL
CPU 7  ┘
```

A normal Spark is allowed to execute only on CPUs `0-5`, while a special Spark can exclusively own CPU `6` or `6-7`.

Incus supports explicit CPU pinning using CPU IDs or ranges through `limits.cpu`. For example, `limits.cpu=6-7` pins an instance to those physical CPU threads. cite

So the dedicated Spark becomes:

```yaml
cpu:
  mode: dedicated
  cores: 2
```

which Spark translates to something like:

```bash
incus config set special-spark limits.cpu=6-7
```

Then the important part: **you must also prevent shared Sparks from using CPUs 6-7**.

I would therefore give every shared Spark:

```bash
limits.cpu=0-5
```

All of them can see the same shared set:

```text
Spark A ─┐
Spark B ─┼── CPUs 0-5
Spark C ─┤
Spark D ─┘
```

and then use `limits.cpu.allowance` / `limits.cpu.priority` to arbitrate between them. Incus implements CPU selection via the `cpuset` cgroup controller and allowance/priority via the CPU controller. cite

So you get:

```text
                  PHYSICAL HOST
             8 logical CPU threads

 ┌─────────────────────────────────────┐
 │                                     │
 │      SHARED CPU POOL                │
 │                                     │
 │       CPU 0 1 2 3 4 5               │
 │                                     │
 │    Spark A    reservation 0.5       │
 │    Spark B    reservation 1.0       │
 │    Spark C    reservation 0.25      │
 │    Spark D    reservation 1.5       │
 │                                     │
 └─────────────────────────────────────┘

 ┌────────────┐       ┌────────────┐
 │ CPU 6      │       │ CPU 7      │
 │            │       │            │
 │ Spark X    │       │ Spark X    │
 │ dedicated  │       │ dedicated  │
 └────────────┘       └────────────┘
```

This should be a first-class concept in the Spark scheduler rather than something users manually configure.

I'd model the host as:

```yaml
cpu:
  total: 8

  pools:
    shared:
      cpus: [0, 1, 2, 3, 4, 5]

    dedicated:
      cpus: [6, 7]
```

But dynamically, you don't even need a permanently predefined dedicated pool.

Suppose initially everything is shared:

```text
Shared:      0 1 2 3 4 5 6 7
Dedicated:   none
```

Then you request:

```yaml
cpu:
  mode: dedicated
  cores: 2
```

Spark can perform:

```text
1. Find two free physical cores
2. Remove them from shared pool
3. Reconfigure shared Sparks' allowed CPU set
4. Pin special Spark to those CPUs
5. Start special Spark
```

Result:

```text
Before

shared = [0,1,2,3,4,5,6,7]


After

shared              = [0,1,2,3,4,5]
special-spark       = [6,7]
```

And when you delete that Spark:

```text
shared = [0,1,2,3,4,5,6,7]
```

So **dedicated CPUs become dynamically carved out of the shared pool**.

That makes the UI elegant as well:

```text
CPU

8 CPU physical capacity

Shared pool
████████████████████████ 6 CPU

Dedicated
████████                 2 CPU

──────────────────────────────────

crm-prod
Shared
0.5 CPU reservation

website
Shared
0.25 CPU reservation

postgres-heavy
Dedicated
2 CPU
```

There is one subtle issue, though.

If your CPU has SMT / Hyper-Threading:

```text
Physical Core 0
    CPU 0
    CPU 8

Physical Core 1
    CPU 1
    CPU 9
```

then assigning only:

```text
CPU 0
```

does **not** give truly exclusive access to physical Core 0, because CPU 8 is its SMT sibling.

For `mode: dedicated`, Spark should understand the physical topology returned by:

```bash
incus info --resources
```

and allocate entire physical cores, including sibling threads. Incus uses explicit CPU IDs for pinning and can also account for CPU/NUMA topology when pinning VMs. cite

So if:

```text
Core 3:
CPU 3
CPU 11
```

then:

```yaml
cpu:
  mode: dedicated
  cores: 1
```

should internally mean:

```text
limits.cpu=3,11
```

not just:

```text
limits.cpu=3
```

That distinction matters a lot for workloads like databases, latency-sensitive services, compilation, inference, etc.

I would consequently define three Spark CPU modes:

```yaml
cpu:
  mode: shared
  reservation: 0.5
```

Meaning:

> Share the general CPU pool. Receive proportional scheduling entitlement.

Then:

```yaml
cpu:
  mode: capped
  max: 0.5
```

Meaning:

> Share the general pool but never consume more than half a CPU worth of execution.

Incus supports hard time quotas such as `50ms/100ms` for this. cite

And finally:

```yaml
cpu:
  mode: dedicated
  cores: 2
```

Meaning:

> Remove two physical cores from the shared pool and make them exclusive to this Spark.

There is actually a fourth mode that could be useful:

```yaml
cpu:
  mode: shared-pinned
  cores: 2
```

Meaning:

> This workload can only run on two selected cores, but those cores are **not exclusive**.

That could be useful for cache locality or NUMA placement without wasting physical capacity.

So your scheduler becomes:

```text
                  Spark CPU Scheduler

                         │
        ┌────────────────┼────────────────┐
        │                │                │
        ▼                ▼                ▼

      SHARED           CAPPED         DEDICATED

 entire shared       shared pool      exclusive
 CPU pool            + hard quota     physical cores

 burst allowed       no burst         no sharing

 0.5 weight          <= 0.5 CPU       2 cores
```

One correction to my previous answer is important here: **I would not rely on Incus's automatic CPU balancing alone for this hybrid model**. Incus dynamically balances instances when `limits.cpu` is given as a count rather than explicit CPU IDs. cite

For Spark, once dedicated CPUs exist, **your control plane should explicitly manage the shared cpuset**. Otherwise your conceptual resource allocator and the kernel's available CPU topology can diverge.

So Spark becomes the authority:

```text
Spark Scheduler
      │
      ├── topology
      │      physical cores
      │      SMT siblings
      │      NUMA nodes
      │
      ├── shared cpuset
      │
      ├── dedicated allocations
      │
      └── reservations
              ↓
            Incus
              ↓
            cgroups
              ↓
         Linux scheduler
```

And that is actually becoming a very nice architecture: **Incus is your execution engine, but Spark owns resource semantics.**

For an 8-core server, you could therefore have 30 tiny shared Sparks and simultaneously one PostgreSQL Spark with two genuinely dedicated physical cores. That's exactly the kind of mixed workload model I'd want Spark to support.
