import { Stack, StackProps, Duration } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as secretsManager from "aws-cdk-lib/aws-secretsmanager";

export interface DatabaseStackProps extends StackProps {
  stage: string;
  appName: string;
  vpc: ec2.Vpc;
}

export class DatabaseStack extends Stack {
  /**
   * Need a reference since when the app is created, its security group will need updating to
   * allow it to access this database (e.g on port 5432). Exporting just the database's security group
   * results in a cyclic reference
   */
  public readonly database: rds.DatabaseInstance;

  /**
   * The ARN of the secret in secrets manager so the app is able to fetch its details by reference without
   * knowing its value
   */
  public readonly databaseCredentialsSecretArn: string;

  constructor(scope: Construct, id: string, props: DatabaseStackProps) {
    super(scope, id, props);

    // important: if create the database security group and export that, it would create a cyclic reference,
    // causing the CDK to fail. The app needs to access the database on port 5432. But ... the app does
    // not exist at this point. It can only add a rule in *its* stack (once *its* security group is created).
    // If we create an empty group here, that is what causes it to fail. Hence creating the security
    // group in the app stack

    const dbEngine = rds.DatabaseInstanceEngine.POSTGRES;
    const dbInstanceType = ec2.InstanceType.of(
      ec2.InstanceClass.BURSTABLE4_GRAVITON,
      ec2.InstanceSize.MICRO
    ); // the smallest/cheapest single instance: a db.t4g.micro
    const dbPort = 5432;
    const dbUsername = "postgres";

    // create a security group (deliberately with no rules here - if need access e.g from a bastion host could add that)
    const databaseSecurityGroup = new ec2.SecurityGroup(
      this,
      `${props.stage}-${props.appName}-database-security-group`,
      { vpc: props.vpc, description: "Control access to the database" }
    );

    // the main user's credentials
    // (it seems that RDS only supports storing/fetching secrets in the more expensive Secrets Manager, not Parameter Store. So create
    // a secret password there where RDS would put it anyway if left it up to it using rds.Credentials.fromGeneratedSecret('name')
    const databaseCredentialsSecret = new secretsManager.Secret(
      this,
      `${props.stage}-${props.appName}-database-credentials-secret`,
      {
        //secretName: `${props.stage}-${props.appName}-database-credentials-secret`,
        description: "Database main user credentials",
        generateSecretString: {
          secretStringTemplate: JSON.stringify({
            username: dbUsername,
          }),
          excludePunctuation: true,
          includeSpace: false,
          generateStringKey: "password",
        },
      }
    );

    /*
    // can show ARN, for reference (this does not show the actual secret!)
    // Note: if you want to create a new database for the app to use, you would need to connect to the database
    // using the credentials in this secret (its username, password and host) from within its VPC (for example
    // an EC2 or Lambda). Make one, then update appStack.ts to use that DB_NAME instead
    new cdk.CfnOutput(this, "Database secret ARN", {
      value: databaseCredentialsSecret.secretArn,
    });
    */

    // the app needs the ARN to fetch it by reference
    this.databaseCredentialsSecretArn = databaseCredentialsSecret.secretArn;

    // create a database
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_rds.DatabaseInstance.html
    this.database = new rds.DatabaseInstance(
      this,
      `${props.stage}-${props.appName}-database`,
      {
        //databaseName: `${props.stage}-${props.appName}-database`,
        vpc: props.vpc,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }, // put in private subnet
        engine: dbEngine,
        instanceType: dbInstanceType,
        port: dbPort,
        multiAz: false, // cheapest (no HA) but adjust as desired
        allowMajorVersionUpgrade: true,
        autoMinorVersionUpgrade: true,
        allocatedStorage: 20, // for a test app need minimal amount, default is 100 GB
        maxAllocatedStorage: 40, // adjust as desired
        deleteAutomatedBackups: false,
        backupRetention: Duration.days(7), // adjust as desired
        securityGroups: [databaseSecurityGroup],
        publiclyAccessible: false,
        credentials: rds.Credentials.fromSecret(databaseCredentialsSecret),
      }
    );

    //database.connections.allowInternally;

    /*
    // note: in a private subnet so only requests originating within the VPC should be allowed but can show it
    new cdk.CfnOutput(this, "Database endpoint", {
      value: this.database.dbInstanceEndpointAddress,
    });
    */
  }
}
