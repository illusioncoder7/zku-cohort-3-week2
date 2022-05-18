// [assignment] please copy the entire modified custom.test.js here
const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, registerAndTransact, prepareTransaction, buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const { encodeDataForBridge } = require('./utils')

const MERKLE_TREE_HEIGHT = 5
const l1ChainId = 1
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(process.env.MINIMUM_WITHDRAWAL_AMOUNT || '0.05')
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(process.env.MAXIMUM_DEPOSIT_AMOUNT || '1')

describe('Custom Tests', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const verifier16 = await deploy('Verifier16')
    const hasher = await deploy('Hasher')

    const token = await deploy('PermittableToken', 'Wrapped ETH', 'WETH', 18, l1ChainId)
    await token.mint(sender.address, utils.parseEther('10000'))

    const amb = await deploy('MockAMB', gov.address, l1ChainId)
    const omniBridge = await deploy('MockOmniBridge', amb.address)

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      'TornadoPool',
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address,
    )

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT,
    )
    const proxy = await deploy(
      'CrossChainUpgradeableProxy',
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId,
    )

    const tornadoPool = tornadoPoolImpl.attach(proxy.address)

    await token.approve(tornadoPool.address, utils.parseEther('10000'))

    return { tornadoPool, token, proxy, omniBridge, amb, gov, multisig }
  }

  it('[assignment] ii. deposit 0.1 ETH in L1 -> withdraw 0.08 ETH in L2 -> assert balances', async () => {
    // [assignment] complete code here
    // loading the contracts
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture);
    // generating a new keypair
    const alice = new Keypair();
    // deposit details
    const depositAmount = utils.parseEther('0.1');
    const depositUtxo = new Utxo({ amount: depositAmount, keypair: alice });

    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [depositUtxo],
    });

    // preparing data for token bridging
    const tokenBridgeData = encodeDataForBridge({
      proof: args,
      extData,
    });

    const tokenBridgeTxn = await tornadoPool.populateTransaction.onTokenBridged(
      token.address,
      depositUtxo.amount,
      tokenBridgeData,
    );

    await token.transfer(omniBridge.address, depositAmount);
    const transferTxn = await token.populateTransaction.transfer(tornadoPool.address, depositAmount);
    // bridging the token
    await omniBridge.execute([
      { who: token.address, callData: transferTxn.data },
      { who: tornadoPool.address, callData: tokenBridgeTxn.data },
    ]);

    // fund withdrawal
    const withdrawAmt = utils.parseEther('0.08');
    // random recipient address 
    const recipient = '0x584Bc94f6de80a1b0635Dd09d45fb71973cdE0bB';
    const changeUtxo = new Utxo({
      amount: depositAmount.sub(withdrawAmt),
      keypair: alice,
    });
    await transaction({
      tornadoPool,
      inputs: [depositUtxo],
      outputs: [changeUtxo],
      recipient: recipient,
      isL1Withdrawal: false,
    });

    const recipientBalance = await token.balanceOf(recipient);
    // asserting recipeient balance
    expect(recipientBalance).to.be.equal(withdrawAmt);

    const omniBridgeBalance = await token.balanceOf(omniBridge.address);
    // asserting bridge balance
    expect(omniBridgeBalance).to.be.equal(0);


    const tornadoPoolBalance = await token.balanceOf(tornadoPool.address);
    // 0.1-0.08 = 0.02 is the remainning balance in pool,asserting the remainging balance
    expect(tornadoPoolBalance).to.be.equal(utils.parseEther('0.02'));
  });

  it('[assignment] iii. see assignment doc for details', async () => {
    // [assignment] complete code here
    // loading the smart contracts
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture)

    // Alice deposits 0.13
    const aliceDepositAmount = utils.parseEther('0.13')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount })
    await transaction({ tornadoPool, outputs: [aliceDepositUtxo] })

    // Generate new wallet for Bob
    const bob = new Keypair()
    const bobAddr = bob.address()

    // alice sends 0.06 eth to bob
    const amountToBob = utils.parseEther('0.06')
    const bobSendUtxo = new Utxo({
      amount: amountToBob,
      keypair: Keypair.fromString(bobAddr)
    })

    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(amountToBob),
      keypair: aliceDepositUtxo.keypair,
    })

    await transaction({
      tornadoPool,
      inputs: [aliceDepositUtxo],
      outputs: [bobSendUtxo, aliceChangeUtxo],
      isL1Withdrawal: false
    })

    const filter = tornadoPool.filters.NewCommitment()
    const fromBlock = await ethers.provider.getBlock()
    const events = await tornadoPool.queryFilter(filter, fromBlock.number)

    let bobReceiveUtxo
    try {
      bobReceiveUtxo = Utxo.decrypt(bob, events[0].args.encryptedOutput, events[0].args.index)
    } catch (e) {
      // we try to decrypt another output here because it shuffles outputs before sending to blockchain
      bobReceiveUtxo = Utxo.decrypt(bob, events[1].args.encryptedOutput, events[1].args.index)
    }
    expect(bobReceiveUtxo.amount).to.be.equal(amountToBob)

    // Bob withdraws a part of his funds from the shielded pool
    const bobWithdrawAmount = amountToBob
    const bobEthAddress = '0x383Bc94f6fe80a1b0635Dd09d45fb71973cdE0bB'
    const bobChangeUtxo = new Utxo({ amount: amountToBob.sub(bobWithdrawAmount), keypair: bob })
    await transaction({
      tornadoPool,
      inputs: [bobReceiveUtxo],
      outputs: [bobChangeUtxo],
      recipient: bobEthAddress,
    })

    const bobBalance = await token.balanceOf(bobEthAddress)
    console.log(bobBalance)
    expect(bobBalance).to.be.equal(bobWithdrawAmount)

    // withdraws a part of his funds from the shielded pool
    const aliceWithdrawAmount = aliceDepositAmount.sub(amountToBob)
    const recipient = '0x95951779656eB7092e0347B114BC0F0328A00CD2'
    const aliceWithdrawUtxo = new Utxo({
      amount: 0,
      keypair: aliceDepositUtxo.keypair,
    })
    await transaction({
      tornadoPool,
      inputs: [aliceChangeUtxo],
      outputs: [aliceWithdrawUtxo],
      recipient: recipient,
      isL1Withdrawal: true,
    })

    // Asserting the balances after txns
    const recipientBalance = await token.balanceOf(recipient)
    expect(recipientBalance).to.be.equal(0)
    const omniBridgeBalance = await token.balanceOf(omniBridge.address)
    expect(omniBridgeBalance).to.be.equal(aliceWithdrawAmount)
    const tornadoPoolBalance = await token.balanceOf(tornadoPool.address)
    expect(tornadoPoolBalance).to.be.equal(0)
  });
})
