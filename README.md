# Live Beats (AWS)

This repository contains the code for deploying the [Live Beats](https://github.com/fly-apps/live_beats) app to AWS Elastic Container Service using the [AWS Cloud Development Kit](https://aws.amazon.com/cdk/).

There are two folders:

- The `app` folder contains a modified version of Live Beats for AWS (for example removing Fly-specific variables).

- The `cdk` folder contains the infrastructure code to deploy it to AWS Elastic Container Service (ECS).

## Prerequisites

1. An AWS account. Even if you already have an AWS account, we **strongly** recommend creating a new one. That limits the impact of adverse events. You can group accounts within an [AWS Organization](https://docs.aws.amazon.com/controltower/latest/userguide/organizations.html) to avoid having to repeatedly enter your billing details.

2. The [AWS CDK](https://docs.aws.amazon.com/cdk/v2/guide/getting_started.html#getting_started_install) installed.

3. The [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) installed and configured.

4. [Docker](https://docs.docker.com/get-docker/) to build an image of the app.

## Deploy to AWS

**Note:** If applicable, add `--profile name` to the `aws` and `cdk` commands. If _not_ provided, it will default to using your main AWS account.

1. Navigate to the CDK folder:

```bash
cd cdk
```

2. Install NPM packages:

```bash
npm install
```

3. Set the AWS region (for example `eu-west-2`):

```bash
aws configure set region eu-west-2
```

4. Bootstrap the CDK in that AWS region:

```bash
cdk bootstrap
```

5. Deploy the foundation:

```bash
cdk deploy foundation-stack
```

6. Deploy the database:

```bash
cdk deploy database-stack
```

7. Deploy the app. This requires Docker to be installed and running (the image will be built locally and pushed to AWS ECR which can take several minutes):

```bash
cdk deploy app-stack
```

You can't use the app _just_ yet though. Live Beats uses GitHub for authentication. When you deployed the app stack, it created a placeholder for a GitHub OAuth client ID/secret and showed you their AWS ARN (two long strings starting `arn:ws:secretsmanager`). You now need to create that.

## Create a GitHub OAuth app.

[Create a GitHub OAuth app](https://github.com/settings/applications/new). Give it a name. Set its Homepage URL to the load balancer's DNS hostname that the CDK generated e.g `http://name-424835706.us-west-2.elb.amazonaws.com` and its authorization callback URL to `http://name-424835706.us-west-2.elb.amazonaws.com/oauth/callbacks/github`. Click the green button. You will be shown its client ID. Click the button below that to _Generate a new client secret_.

Now run these commands to tell the app what they are:

```bash
aws secretsmanager update-secret --secret-id "arn:aws:secretsmanager...the-github-client-id-one" --secret-string "your-github-client-id"
aws secretsmanager update-secret --secret-id "arn:aws:secretsmanager...the-github-client-secret-one" --secret-string "your-github-client-secret"
```

## Start the app

In `lib/appStack.ts`, look for `desiredCount: 0` and change that to `desiredCount: 2` to run _two_ containers (we are not using auto-scaling).

Deploy the app stack again. That will start the containers and fetch the updated secrets:

```bash
cdk deploy app-stack
```

Paste the load balancer's hostname in a new browser tab. You should see the Live Beats sign in page. Click the button to sign in using your GitHub app.

## Useful commands

- `cdk synth` to emit a synthesized CloudFormation template which you can scroll through.
- `cdk diff` to compare the stack with its current state.

## Notes

- You will be prompted to approve some deploys (for example if they involve changing IAM policies). You can avoid being asked by adding `--require-approval never`.
- This project uses `v2.81.0"` for `@aws-cdk/*`.
- If you would like to generate your own `SECRET_KEY_BASE` from `mix phx.gen.secret` simply update the secret we made using the same CLI call, as above. Just use the `arn` of _that_ secret which you can get from the stack, CLI or console.

## Clean up

AWS Resources incur a cost. If you are sure, you can delete the stacks:

```bash
cdk destroy app-stack
cdk destroy database-stack
cdk destroy foundation-stack
```

## HTTPS?

You will have noticed that the default load balancer only listens on HTTP/80. You _can_ use HTTPS/443 but to do that you need to _also_ specify an SSL certificate for it to use. _That_ means using a domain that you can verify ownership of (by email or DNS). ACM can then issue a certificate and it would become available for the load balancer to use.

You would then need to modify the app stack to use `443` in place of `80`. For example for the load balancer's listener and its security group.

Finally you would edit your DNS records to CNAME your `example.com` to the load balancer's hostname.

## Errors?

The best place to start debugging is by looking at the logs. For ECS, it logs to Cloudwatch. You can also see its logs by clicking on your ECS cluster, on its service, and then on the "Logs" tab. After a successful deploy you should see something like:

```
17:41:20.680 [info] Access LiveBeatsWeb.Endpoint at http://1234567.eu-west-2.elb.amazonaws.com
17:41:20.679 [info] Running LiveBeatsWeb.Endpoint with cowboy 2.9.0 at 0.0.0.0:4000 (http)
```

You will see requests every few seconds to `/signin`. That is the load balancer's health check. For containers to register behind it and be healthy, that needs to report back with a `200` status code:

```
17:41:54.954 request_id=F2WFlghur7wnLQMAAAFy [info] Sent 200 in 1ms
```

Any error message should indicate the problem. For example it may complain the database does not exist, or it could not connect to it. You can then investigate (such as whether the security group allows access).

If you see:

```
17:48:38.799 [error] Could not check origin for Phoenix.Socket transport.
```

... _that_ is caused by using a different hostname than the app expects. That results in a WebSocket error (a red panel in the top-right saying "Re-establishing connection"). Make sure the container's `PHX_HOST` environment variable _exactly_ matches the hostname in the browser. In the CDK stack, we set that to the load balancer's hostname. One thing that is _very_ easy to miss is if the _case_ does not match. For example the _default_ load balancer DNS names use _uppercase_ characters. Browsers can silently convert that to _lowercase_, resulting in the hostname _not_ matching what the app expects (since its case differs).

If you see:

```
18:41:58.620 [warn] [libcluster:ecs] Error {:error, {"InvalidParameterException", "Tasks cannot be empty."}} while determining nodes in cluster via ECS strategy.
```

... check the "Tasks" tab in the AWS console for the service to confirm the tasks are indeed listed as running. Each task has one container and so if you have set that as `2`, there should be two listed.

It's also worth keeping an eye on your database in the RDS console. Check the CPU load and number of connections do not seem excessively high. Any issues with that will of course impact the app. You can try adjusting the `POOL_SIZE` and re-deploying the app stack.
