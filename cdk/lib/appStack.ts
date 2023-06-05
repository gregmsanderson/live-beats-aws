import { Stack, StackProps, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsManager from "aws-cdk-lib/aws-secretsmanager";
import * as elasticloadbalancingv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";

export interface AppStackProps extends StackProps {
  stage: string;
  appName: string;
  vpc: ec2.Vpc;
  databaseCredentialsSecretArn: string; // it's an ARN
  database: rds.DatabaseInstance;
}

export class AppStack extends Stack {
  public readonly ecsLoadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer;

  constructor(scope: Construct, id: string, props: AppStackProps) {
    super(scope, id, props);

    // generally it's better to not give names in case resources need to be replaced. For example
    // if you delete a secret from Secrets Manager, it waits 7-30 days and it is not possible
    // to create another secret with the same name. So that would prevent a subsequent re-deploy of the stack. BUT we
    // need to set some e.g the ECS cluster and ECS service name in order to construct an ARN for
    // our custom libcluster strategy
    const relativeAppPath = "../app"; // if build an image on-deploy, it needs to now the folder the app is in
    const ecsClusterName = props.appName + "-ecs-cluster";
    const ecsServiceName = props.appName + "-ecs-service";

    // security group (ECS service's load balancer)
    const ecsAlbSecurityGroup = new ec2.SecurityGroup(
      this,
      `${props.stage}-${props.appName}-ecs-alb-security-group`,
      { vpc: props.vpc, description: "Control access to the ECS load balancer" }
    );
    ecsAlbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "Allow HTTP traffic from anywhere"
    );

    // security group (ECS service)
    const ecsServiceSecurityGroup = new ec2.SecurityGroup(
      this,
      `${props.stage}-${props.appName}-ecs-service-security-group`,
      { vpc: props.vpc, description: "Control access to the ECS service" }
    );
    ecsServiceSecurityGroup.connections.allowFrom(
      new ec2.Connections({
        securityGroups: [ecsAlbSecurityGroup],
      }),
      ec2.Port.tcp(4000),
      "Allow TCP traffic on port 4000 from the load balancer"
    );
    // to enable containers within the cluster to talk to each other, allow inbound from the VPC's CIDR. Not sure
    // if the port/range can be locked down to e.g 4369, 9000 or whatever port/range Phoenix actually uses
    ecsServiceSecurityGroup.connections.allowFrom(
      ec2.Peer.ipv4(props.vpc.vpcCidrBlock),
      ec2.Port.allTcp(),
      "Allow TCP traffic from other nodes for libcluster"
    );

    // this should allow the app to access the database, using allowTo (doing it the other way round ie adding
    // an inbound rule to the database's security group ... would create a cyclic dependency between
    // stacks. To do it that way, would need to merge the database stack and app stack)
    // Idea from https://stackoverflow.com/a/66979255
    ecsServiceSecurityGroup.connections.allowTo(
      props.database,
      ec2.Port.tcp(5432),
      "Allow traffic on port 5432 from the ECS service to the database"
    );

    // ECS task IAM role
    const taskRole = new iam.Role(
      this,
      `${props.stage}-${props.appName}-ecs-task-role`,
      {
        //roleName: `${props.stage}-${props.appName}-ecs-task-role`,
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      }
    );
    // in case want to use ECS Exec aka SSH
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssmmessages:CreateControlChannel",
          "ssmmessages:CreateDataChannel",
          "ssmmessages:OpenControlChannel",
          "ssmmessages:OpenDataChannel",
        ],
        resources: ["*"],
      })
    );
    // for the custom libcluster strategy
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ["ecs:ListServices", "ecs:ListTasks", "ecs:DescribeTasks"],
        resources: ["*"],
      })
    );
    // for logging to Cloudwatch
    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:DescribeLogStreams",
          "logs:PutRetentionPolicy",
          "logs:PutLogEvents",
        ],
        resources: ["arn:aws:logs:*:*:log-group:/*"],
      })
    );

    // ECS execution IAM role (needed to let it fetch secrets e.g from SSM)
    const executionRole = new iam.Role(
      this,
      `${props.stage}-${props.appName}-ecs-execution-role`,
      {
        //roleName: `${props.stage}-${props.appName}-ecs-execution-role`,
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      }
    );
    // the whole of AmazonECSTaskExecutionRolePolicy which it would give itself by default anyway
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ecr:GetAuthorizationToken",
          "ecr:BatchCheckLayerAvailability",
          "ecr:GetDownloadUrlForLayer",
          "ecr:BatchGetImage",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
        ],
        resources: ["*"],
      })
    );
    // to fetch/decrypt secrets from AWS Systems Manager Parameter Store
    executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameters",
          "secretsmanager:GetSecretValue",
          "kms:Decrypt",
        ],
        resources: ["*"],
      })
    );

    // task definition
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.FargateTaskDefinition.html
    const taskDefinition = new ecs.FargateTaskDefinition(
      this,
      `${props.stage}-${props.appName}-ecs-task-definition`,
      {
        cpu: 256, // min 256, but only certain combinations of CPU/RAM are supported by Fargate: check AWS docs
        memoryLimitMiB: 512, // min 512
        taskRole: taskRole,
        executionRole: executionRole,
      }
    );

    const ecsCluster = new ecs.Cluster(
      this,
      `${props.stage}-${props.appName}-ecs-cluster`,
      {
        clusterName: ecsClusterName, // needed for our libcluster strategy
        vpc: props.vpc,
      }
    );

    // since using a custom libcluster strategy, the container needs an environment variable AWS_ECS_SERVICE_ARN
    // which is the serviceArn. If hard-coded in the cluster and service names, could construct that e.g
    // "arn:aws:ecs:eu-west-2:1234567:service/live-beats-cluster/live-beats-service"
    // ... but would prefer not to. So try and build what it will be. This
    // dea from https://github.com/aws/aws-cdk/issues/16634#issuecomment-1000312654
    const ecsServiceArn = this.formatArn({
      service: "ecs",
      resource: "service",
      resourceName: `${ecsClusterName}/${ecsServiceName}`,
    });

    // create a load balancer for the service (created here so can reference its hostname as PHX_HOST
    // else get a WebSocket error in the app as it assumes it is "example.com")
    // IMPORTANT: we give it a name because if you don't, it will generate a random one. For some reason
    // that decides to use capital letters e.g app-s-stagi-BBMFMLI304BC-12345.eu-west-2.elb.amazonaws.com. Which
    // is a problem. Browsers and other services will either silently convert it to lowercase (subtle) or expect
    // a lowercase DNS name. For LiveView, that results in WebSocket errors as it is case-sensitive on PHX_HOST, sigh. So
    // we give it a lowercase name to hopefully avoid that and ensure its full DNS name is lowercase
    // https://github.com/aws/aws-cdk/issues/11171
    this.ecsLoadBalancer = new elasticloadbalancingv2.ApplicationLoadBalancer(
      this,
      `${props.stage}-${props.appName}-ecs-lb`,
      {
        loadBalancerName: `${props.stage}-${props.appName}-ecs-lb`, // max 32 characters else fails
        vpc: props.vpc,
        internetFacing: true,
        securityGroup: ecsAlbSecurityGroup, // we specify it so it won't create one
      }
    );
    const lbListener = this.ecsLoadBalancer.addListener(
      `${props.stage}-${props.appName}-ecs-load-balancer-listener`,
      { port: 80 }
    ); // note: if had ACM certificate could use 443 here for HTTPS, but would need a custom domain for that so skipped doing that

    new cdk.CfnOutput(this, "Load balancer DNS name", {
      value: this.ecsLoadBalancer.loadBalancerDnsName, // e.g my-load-balancer-424835706.us-west-2.elb.amazonaws.com (hopefully lowercase!)
    });

    // APP SECRETS

    // need to store encrypted, so that means using Secrets Manager OR SSM Parameter Store.
    // The CDK does not support creating SecureString using SSM:
    // https://github.com/aws/aws-cdk/issues/3520#issuecomment-577667105
    // So ... either:
    // 1. have to ask the user to create the secret in SSM in advance e.g by asking them to run ...
    // aws ssm put-parameter --name "/live-beats/release-cookie" --value "cookie-value-here" --type "SecureString"
    // ... and use name/arn in the CDK to fetch that existing secret e.g like
    // SECRET_KEY_BASE: ecs.Secret.fromSsmParameter( ... ).
    // 2. create the secret using Secrets Manager here in the stack.
    // Each approach has its own advantages. For now using Secrets Manager to create secrets, and then asking
    // the user to update them e.g with their Github Client ID/secret when known
    // e.g crypto.randomBytes(64).toString('hex')

    // SECRET_KEY_BASE
    // https://hexdocs.pm/phoenix/deployment.html
    const secretKeyBaseSecret = new secretsManager.Secret(
      this,
      `${props.stage}-${props.appName}-secret-key-base-secret`,
      {
        //secretName: `${props.stage}-${props.appName}-secret-key-base-secret`,
        description: "Phoenix needs a secret key",
        generateSecretString: {
          excludeLowercase: false,
          excludeNumbers: false,
          excludeUppercase: false,
          excludePunctuation: true,
          includeSpace: false,
          passwordLength: 64,
        },
      }
    );

    /*
    // show ARN (if a user wants to provide their own e.g from running: mix phx.gen.secret)
    new cdk.CfnOutput(this, "Secret Key Base ARN", {
      value: secretKeyBaseSecret.secretArn,
    });
    */

    // RELEASE_COOKIE
    // https://fly.io/docs/elixir/the-basics/clustering/#the-cookie-situation
    const releaseCookieSecret = new secretsManager.Secret(
      this,
      `${props.stage}-${props.appName}-release-cookie-secret`,
      {
        //secretName: `${props.stage}-${props.appName}-release-cookie-secret`,
        description: "Nodes need to share a secret cookie to cluster",
        generateSecretString: {
          excludeLowercase: false,
          excludeNumbers: false,
          excludeUppercase: false,
          excludePunctuation: true,
          includeSpace: false,
          passwordLength: 64,
        },
      }
    );

    // note: technically don't have to create these client ID/secret as could rely on user to do that however the appeal
    // is then can get an arn AWS gives them, meaning it is then easy for the user to provide that arn for updating
    // once they know the hostname and so can create the app in GitHub e.g with:
    // aws secretsmanager update-secret --secret-id [arn] --secret-string [client-id-here]

    // LIVE_BEATS_GITHUB_CLIENT_ID
    const liveBeatsGitHubClientIdSecret = new secretsManager.Secret(
      this,
      `${props.stage}-${props.appName}-live-beats-github-client-id-secret`,
      {
        //secretName: `${props.stage}-${props.appName}-live-beats-github-client-id-secret`,
        description:
          "GitHub OAuth Client ID (the Live Beats app uses GitHub OAuth for authentication)",
        generateSecretString: {
          excludeLowercase: false,
          excludeNumbers: false,
          excludeUppercase: false,
          excludePunctuation: true,
          includeSpace: false,
          passwordLength: 32,
        },
      }
    );

    // show ARN (this does not show the actual secret!) So the user can run e.g
    // aws secretsmanager update-secret --secret-id [arn] --secret-string [client-id-here]
    new cdk.CfnOutput(this, "GitHub OAuth Client ID ARN", {
      value: liveBeatsGitHubClientIdSecret.secretArn,
    });

    // LIVE_BEATS_GITHUB_CLIENT_SECRET
    const liveBeatsGitHubClientSecretSecret = new secretsManager.Secret(
      this,
      `${props.stage}-${props.appName}-live-beats-github-client-secret-secret`,
      {
        //secretName: `${props.stage}-${props.appName}-live-beats-github-client-secret-secret`,
        description:
          "GitHub OAuth Client secret (the Live Beats app uses GitHub OAuth for authentication)",
        generateSecretString: {
          excludeLowercase: false,
          excludeNumbers: false,
          excludeUppercase: false,
          excludePunctuation: true,
          includeSpace: false,
          passwordLength: 32,
        },
      }
    );

    // show ARN (this does not show the actual secret!) So the user can run e.g
    // aws secretsmanager update-secret --secret-id [arn] --secret-string [client-secret-here]
    new cdk.CfnOutput(this, "GitHub OAuth Client secret ARN", {
      value: liveBeatsGitHubClientSecretSecret.secretArn,
    });

    // DATABASE CREDENTIALS
    // this secret has *already* been created (in a different stack). So we need to fetch it, not create it. We
    // exported a string/arn when creating the database so that's the method we need to use to fetch it:
    const databaseCredentialsSecret =
      secretsManager.Secret.fromSecretCompleteArn(
        this,
        `${props.stage}-${props.appName}-live-beats-imported-database-credentials-secret`,
        props.databaseCredentialsSecretArn
      );

    // CONTAINER

    // add a container to the task definition (the only/essential one):
    // note: unfortunately there doesn't seem to be a way to get a fully-formed connection string
    // e.g for DATABASE_URL. We only have separate values in the JSON. We can't make a SecureString
    // in SSM so would either need to make another secret in SecretsManager (duplicating the password
    // and risking inconsistency on rotation) or use the separate values. So seemed simpler
    // to use e.g DB_PASSWORD etc
    // https://www.reddit.com/r/aws/comments/rzfskp/amazon_rds_amazon_secrets_manager_retrieving/
    const container = taskDefinition.addContainer(
      `${props.stage}-${props.appName}-ecs-container`,
      {
        //containerName: `${props.stage}-${props.appName}-container`,
        image: ecs.ContainerImage.fromAsset(relativeAppPath), // build on-deploy
        //image: ecs.ContainerImage.fromEcrRepository(repo, tagOrDigest) // pre-built
        portMappings: [
          {
            name: `${props.stage}-${props.appName}-port-4000-tcp`,
            containerPort: 4000,
            protocol: ecs.Protocol.TCP,
            appProtocol: ecs.AppProtocol.http,
          },
        ],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: `/ecs/${props.stage}-${props.appName}-ecs-app`,
          logRetention: 30,
        }),
        environment: {
          PHX_HOST: this.ecsLoadBalancer.loadBalancerDnsName, // to avoid WebSocket error the app needs to know its hostname
          POOL_SIZE: "2", // default is 10 (adjust this depending on DB instance size)
          AWS_ECS_CLUSTER_REGION: props.env?.region || "", // e.g "eu-west-2"
          AWS_ECS_CLUSTER_NAME: ecsClusterName,
          AWS_ECS_SERVICE_ARN: ecsServiceArn,
          DB_NAME: "postgres", // note: if want to use a new database, create that after deploying the database stack but before deploying this one. And update its name here
        },
        secrets: {
          DB_USERNAME: ecs.Secret.fromSecretsManager(
            databaseCredentialsSecret,
            "username"
          ),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(
            databaseCredentialsSecret,
            "password"
          ),
          DB_HOST: ecs.Secret.fromSecretsManager(
            databaseCredentialsSecret,
            "host"
          ),
          DB_PORT: ecs.Secret.fromSecretsManager(
            databaseCredentialsSecret,
            "port"
          ),
          SECRET_KEY_BASE: ecs.Secret.fromSecretsManager(secretKeyBaseSecret),
          RELEASE_COOKIE: ecs.Secret.fromSecretsManager(releaseCookieSecret),
          LIVE_BEATS_GITHUB_CLIENT_ID: ecs.Secret.fromSecretsManager(
            liveBeatsGitHubClientIdSecret
          ),
          LIVE_BEATS_GITHUB_CLIENT_SECRET: ecs.Secret.fromSecretsManager(
            liveBeatsGitHubClientSecretSecret
          ),
        },
      }
    );

    // service
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_ecs.FargateService.html
    const ecsService = new ecs.FargateService(
      this,
      `${props.stage}-${props.appName}-ecs-service`,
      {
        serviceName: ecsServiceName, // for our custom libcluster strategy
        cluster: ecsCluster,
        taskDefinition,
        desiredCount: 0, // default is 1. Or can use auto-scaling. Start with 0 just to get the stack deployed, then can increase it
        securityGroups: [ecsServiceSecurityGroup], // to e.g permit access only from the load balancer
        assignPublicIp: true, // is this needed?
        circuitBreaker: { rollback: true },
        minHealthyPercent: 50,
        maxHealthyPercent: 500, // careful setting these as deployments can be accidentally blocked e.g if set this as 100 ... and there is still a prior container running!
        enableExecuteCommand: true, // to allow SSH in to containers
        vpcSubnets: {
          subnetType: ec2.SubnetType.PUBLIC,
        }, // since "by default, the instances are placed in the private subnets" ... but we have no NAT gateway and need a route to the internet (for secrets)
      }
    );

    // now there is an ECS service, that can bee added as a target for the load balancer
    const lbTargetGroup = lbListener.addTargets(
      `${props.stage}-${props.appName}-ecs-load-balancer-target-group1`,
      {
        port: 4000,
        protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
        targets: [ecsService],
        healthCheck: {
          path: "/signin",
          healthyThresholdCount: 2,
          unhealthyThresholdCount: 2,
          interval: cdk.Duration.seconds(5), // interval must be higher than timeout
          timeout: cdk.Duration.seconds(3),
        },
      }
    );
    // the default time for connection draining is often too long.
    // Increase/decrease this time as needed by your app:
    // https://github.com/aws/aws-cdk/issues/4015#issuecomment-553007260
    lbTargetGroup.setAttribute("deregistration_delay.timeout_seconds", "10");
  }
}
